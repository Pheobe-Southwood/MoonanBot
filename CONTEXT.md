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

**Director Note**:
A user-visible account of the Simulation Agent's psychological or narrative analysis that is never sent as a chat message.
_Avoid_: Reply, hidden reasoning

**Action**:
A validated thing the Character does through `perform_action`, including using the phone, idling, and sleeping.
_Avoid_: Tool call

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
## Social world

**Contact**:
A person observed through the platform, whether or not the platform marks them as a friend.
_Avoid_: Friend

**Message Importance**:
The Character's notification policy for one Contact: priority plus, priority, normal, do not disturb, or no push.
_Avoid_: Relationship strength

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
