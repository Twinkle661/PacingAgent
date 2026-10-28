import queue
import threading
import json
import logging
from datetime import datetime, timedelta
from dataclasses import dataclass, asdict

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)


# config

config = {
    "debug": False,
    "llm_timeout": 180,
    "pacer": {
        "duration_min": 300,  #seconds
        "duration_max": 28800,
        "recent_messages": 8
    }
}

# Prompts

class Prompts:
    def request_instruction(self, **kwargs) -> str:
        prompt = ""
        return 
    def request_context(self, msgs, timer_status) -> str:
        parted_prompt = [
            "<existing_timer>",
            json.dumps(asdict(timer_status), default=str),
            "</existing_timer>",
            "<recent_messages>",
            json.dumps(msgs),
            "</recent_messages>"
        ]
        return "\n\n".join(parted_prompt)
    def return_msg(self) -> str:
        return f"[Time Passed: it is {datetime.now().strftime('%H:%M:%S')} now.]"

# Schema

def make_pacer_schema(config):
    schema = {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["start", "postpone", "cancel", "keep"]
            },
            "delay_seconds": {
                "type": "integer",
                "minimum": config["pacer"]["duration_min"],
                "maximum": config["pacer"]["duration_max"]
            }
        },
        "required": ["action", "delay_seconds"],
        "additionalProperties": False
    }

    if config["debug"]:
        schema["properties"]["reason"] = {"type": "string"}
        schema["required"].append("reason")
    return schema

# Pacer Logic

@dataclass
class TimerStatus:
    active: bool = False
    updated: datetime | None = None
    starting: datetime | None = None
    duration: int = 0
    ending: datetime | None = None


class AgentPacer:
    def __init__(self, ctx, config):
        self.task = None
        self.ctx = ctx
        self.config = config
        self.prompt = Prompts()
        self.msgs_queue = queue.Queue()
        self.pacer_schema = make_pacer_schema(config)

        self.timer_task = None
        self.timer_status = TimerStatus()

        self.worker_thread = threading.Thread(
            target=self.pacing_worker,
            daemon=True
        )
        self.worker_thread.start()

        self.session_key = None

    # LLM Request
    def pacing_worker(self):
        while True:
            recents = self.msgs_queue.get()
            try:
                result = self.ctx.llm.complete_structured(
                    instructions=(self.prompt.request_instruction()),
                    input=[{
                            "type": "text",
                            "text": self.prompt.request_context(recents["msgs"], self.timer_status)
                    }],
                    json_schema=self.pacer_schema,
                    task="pacer",
                    temperature=0,
                    max_tokens=512,
                    timeout=self.config["llm_timeout"],
                )

                if result.parsed is None:
                    raise ValueError(f"Invalid LLM output: {result.text}")

                self.timer_routs(
                    result.parsed,
                    recents["time"]
                )
            except Exception:
                logger.error("Pacer worker failed")
            finally:
                self.msgs_queue.task_done()

    # Timer
    def timer_start(self, duration: int, start_time: datetime, end_time: datetime):
        self.timer_cancel()

        self.timer_status.active = True
        self.timer_status.starting = start_time
        self.timer_status.duration = duration
        self.timer_status.ending = end_time

        wait_seconds = (end_time - datetime.now()).total_seconds()

        self.timer_task = threading.Timer(
            wait_seconds,
            self.timer_fire
        )
        self.timer_task.daemon = True
        self.timer_task.start()

    def timer_cancel(self):
        if self.timer_task is not None:
            self.timer_task.cancel()
            self.timer_task = None

        self.timer_status.active = False
        self.timer_status.starting = None
        self.timer_status.duration = 0
        self.timer_status.ending = None

    def timer_keep(self):
        pass

    def timer_routs(self, pacing, msg_time):
        self.timer_status.updated = msg_time

        if pacing["action"] == "cancel":
            self.timer_cancel()
            return
        if pacing["action"] == "keep":
            self.timer_keep()
            return

        duration = 0
        started = None

        if pacing["action"] == "start":
            duration = pacing["delay_seconds"]
            start_time = msg_time
        if pacing["action"] == "postpone":
            duration = self.timer_status.duration + pacing["delay_seconds"]
            start_time = self.timer_status.starting

        exp_end_time = start_time + timedelta(seconds=duration)
        if (exp_end_time - datetime.now()).total_seconds() <= 60 : # Would not bother to postpone for less than 1 min
            return

        if pacing["action"] in ["start", "postpone"]:
            self.timer_start(duration, start_time, exp_end_time)
    
    # Hermes part
    def pacing_put(self, conversation_history, **kwargs):
        history = conversation_history
        recents = [
            {
                "role": msg["role"],
                "content": msg["content"]
            }
            for msg in history
            if (
                isinstance(msg, dict)
                and msg.get("role") in ("user", "assistant")
            )
        ][-self.config["pacer"]["recent_messages"]:]

        self.msgs_queue.put_nowait({
            "time": datetime.now(),
            "msgs": recents
        })

    def timer_fire(self):
        if self.session_key is None:
            return

        self.ctx.inject_message(
            self.prompt.return_msg(),
            role="user",
            session_key=self.session_key
        )

        self.timer_cancel()
    
    def capture_gateway_session(self, session_key, **kwargs):
        self.session_key = session_key

# Regist to Hermes
def register(ctx):
    ctx.register_auxiliary_task(
        "pacer",
        display_name="Agent Pacer",
        description="Decide the next conversational timer action."
    )

    pacer = AgentPacer(ctx, config)

    ctx.register_hook("post_gateway_admission", pacer.capture_gateway_session)
    ctx.register_hook(
        "post_llm_call",
        pacer.pacing_put
    )