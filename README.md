# P2P Manager
Manage a network of peers in a peer-to-peer network.

## Usage
When a message comes in from a peer, the Manager looks for a function on itself named `commandMessage`, where `command` is the command given in the message. If found, it is called, with one argument passed (the payload of the command, as a Buffer). The Manager then emits an event named for the command given, with a payload of:

```
{
  peer: Peer,
  data: message payload
}
```

If the handler returns false, the event is not emitted.

When an event comes from a Peer object (`connect`, `error`, or `end`), the Manager looks for a method on itself called `handleConnect`, `handleError`, or `handleEnd` respectively, with the Peer object as an argument. If the `handleConnect` method has been defined and it returns false, the Peer is disconnected. After calling `handleError` or `handleEnd`, the Peer is disconnected, regardless of return value.