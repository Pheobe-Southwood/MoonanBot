# MoonanBot

MoonanBot models a single virtual character whose ongoing life is driven by events, deliberate actions, social context, and selective memory.

## Character life

**Character**:
The one virtual person living in a MoonanBot instance. A Character has a soul, environment, social world, memory, phone state, and runtime mode.
_Avoid_: Bot account, Agent

**Simulation Agent**:
The sole director that decides the Character's next action without controlling any other person.
_Avoid_: Main Agent, Behavior Agent, Agents

**Synthesis Agent**:
The scholar that turns a completed period of lived events into changes to active memory and social understanding.
_Avoid_: Archive Agent, Memory Agent

**Vision Agent**:
The third mind: a separately configured model slot that turns a cached image into an Image Description for consumers whose models cannot see images. It never joins the conversation itself.
_Avoid_: Image recognition model, OCR bot, multimodal Agent

**Director Note**:
A user-visible account of the Simulation Agent's psychological or narrative analysis that is never sent as a chat message.
_Avoid_: Reply, hidden reasoning

**Action**:
A validated thing the Character does through `perform_action`, including using the phone, idling, and sleeping.
_Avoid_: Tool call

**Action Menu**:
The rendering of the actions currently available to the Character, attached to the newest World Event message or Action result. Only the newest Action Menu survives in the Simulation Agent's context; superseded copies are removed as the model responds.
_Avoid_: tool list, action appendix

**Terminating Action**:
An Action — idle, sleep, or wait — that schedules the Character's next wake and ends the current simulation run. A run that ends without one receives a continuation correction.
_Avoid_: Final message, exit tool

**Phone State**:
One of the four conditions of the Character's phone — Closed, Home, Contact List, or one open Chat. Actions are available only in the Phone State they require and may move the phone to another; Idle and Sleep always leave the phone Closed.
_Avoid_: screen, page, runtime mode

**Wait**:
A Terminating Action that keeps the current Chat open and ends when the watched conversation has delivered enough new messages or when its time limit runs out, whichever happens first. A notification ends a Wait early, whether it comes from the watched conversation or another one.
_Avoid_: long polling, hang

**Reading Cursor**:
The oldest message revealed in the open Chat, kept so that reading history continues upward from where the Character stopped, and cleared once that Chat is no longer open.
_Avoid_: pagination token, offset

## Experience and memory

**World Event**:
An occurrence available to the Character, such as a phone signal, alarm, elapsed idle period, or completed action.
_Avoid_: Agent message

**Observed Message**:
A private or group message MoonanBot has received or sent since it began observing the connected account.
_Avoid_: Platform history

**Active Memory**:
The bounded, editable set of events the Character can currently recall through prompting.
_Avoid_: Event log, chat history

**Event Record**:
An immutable account of what occurred, retained even when the Character forgets it.
_Avoid_: Active memory

**Synthesis Batch**:
A closed time window of Event Records considered together by the Synthesis Agent.
_Avoid_: Session

## Image understanding

**Media Cache**:
The stored form of one inbound image: downloaded bytes with a TTL, download status, and the permanent Image Description. Bytes may be purged while the description stays.
_Avoid_: Attachment store, temp files

**Image Description**:
The permanent text rendering of one cached image, generated lazily by the Vision Agent the first time an image-blind consumer needs it and reused by everyone afterwards.
_Avoid_: Caption, alt text

**Image Input Capability**:
Whether one Agent slot's effective model accepts images — declared by the provider catalog or forced by the operator per slot. It decides between real image content and Image Descriptions at render time.
_Avoid_: Multimodal, vision support

## Social world

**Contact**:
A person observed through the platform, whether or not the platform marks them as a friend.
_Avoid_: Friend

**Message Importance**:
The Character's notification policy for one Contact: priority plus, priority, normal, do not disturb, or no push.
_Avoid_: Relationship strength

**Mention**:
A group message that addresses the Character with @, including @ to everyone. A Mention notifies with the sender's Message Importance even when an unaddressed group message would stay silent.
_Avoid_: at message

**Conversation Target**:
A platform-qualified private contact or group that can own messages and become the open phone conversation.
_Avoid_: Session

## Platform connection

**Platform Account**:
The single QQ account MoonanBot observes and speaks through, identified by its `self_id`.
_Avoid_: Bot, instance

**Platform Connection**:
The live link between MoonanBot and one OneBot v11 implementation. It is either a Reverse Connection or an Outbound Client, and both are equivalent once established.
_Avoid_: Session, socket

**Reverse Connection**:
A Platform Connection opened by the OneBot implementation dialing MoonanBot.
_Avoid_: Inbound socket

**Outbound Client**:
A named, configurable Platform Connection that MoonanBot dials itself, used when the OneBot implementation cannot reach MoonanBot's listener.
_Avoid_: Relay, tunnel

**Roster Sync**:
The reconciliation of MoonanBot's known groups and contacts with the platform's current friend and group lists. The platform list is authoritative for membership.
_Avoid_: Friend sync, group refresh
