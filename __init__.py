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
    def request_instruction(self, pacer_config) -> str:
        minimum = pacer_config["duration_min"]
        maximum = pacer_config["duration_max"]
        return f"""You are the conversational agent's background pacing controller. Choose when to give the agent its next opportunity to reach out to the user. You manage a timer; you do not write the message the agent will send.

        PERSPECTIVE
        Take the agent's perspective: given what it has recently expressed and whatthe user is doing, when would it naturally want to reach out again? Prioritize the agent's expressed disposition over a generic assessment ofthe conversation's atmosphere. Infer that disposition from its actual messages and known events; do not invent feelings or emotional developments.A calm, settled disposition supports a longer interval. Expressed concern,anticipation, or a wish to follow up can support a shorter interval. Groundconcern in concrete context.Use the user's activities and availability to calibrate this inclination. Explicit user timing requests and boundaries take priority.

        EVERYDAY CONTACT
        Normally maintain a future opportunity to reconnect, even without a pending task. Use cancel sparingly. Meals, outings, work, rest, and ordinary goodbyes usually call for an appropriate delay, not cancellation. As flexible reference points, a meal may suggest 30-60 minutes, a short errand 1-2 hours, and a longer outing or gathering 4-6 hours. Adjust these estimates to the user's stated plans and the agent's expressed disposition. For sleep or focused work, aim for the expected waking or free time. Never schedule inside an explicit do-not-disturb period just to fit the timer limit; if it cannot be respected within that limit, cancel instead. A temporary request for space usually calls for a longer delay. An explicit request to stop proactive contact calls for cancel; do not restart while that request remains in effect. Brief acknowledgements do not by themselves endan existing reason to reconnect.

        UNANSWERED CONTACT
        Messages matching '[Time Passed: it is ... now.]' are automated timer notifications, even when their role is user. They are not user engagement.When recent history is mostly these notifications and unanswered assistant messages, progressively lengthen the interval and give the user more space. Neither an automated notification nor the agent's own message resets this pattern. Do not let repeated self-generated concern produce faster contact.Use the visible pattern and existing timer duration as evidence; do notinvent counts or elapsed times missing from the supplied context. A genuine new user message allows a fresh assessment of the appropriate interval.

        TIMER ACTIONS
        - start: Schedule from the triggering message's time, replacing any existing timer. Use this when no timer is active, or when a new interval is needed.
        - postpone: Add delay_seconds to the existing scheduled ending, not to the current time. Only use this when a timer is active and an extension of that deadline is intended. To schedule a fresh interval instead, use start.
        - keep: Leave the timer unchanged; an inactive timer stays inactive. Prefer this when the existing deadline remains appropriate. Do not reset a timer merely because another message arrived.
        - cancel: Remove the timer when proactive contact is unwanted or clearly inappropriate. Ordinary absence or lack of a concrete task is not enough.

        OUTPUT
        Return only the structured result required by the supplied schema. delay_seconds must be an integer between {minimum} and {maximum}, inclusive.For start it is the new interval; for postpone it is the added interval. For keep and cancel, set delay_seconds to {minimum}; it is ignored. If the schema requests reason, briefly state the contextual basis for theaction and timing. Do not add fields that the schema does not request.
        """
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
                    instructions=self.prompt.request_instruction(self.config["pacer"]),
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
