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

## `Manager.send()`
The Manager allows sending messages to a collection of Peers at once, based on certain criteria. The most common criteria is the "state" of the Peer. Each Peer object has a `state` property which is set to `'new'` when first created, `'connecting'` when first opened, and `'connected'` when first `connect` event is heard (before `handleConnect` is called, so that can be overwritten, if desired). Any other states are up to your Manager instance to implement.

* `number`: How many peers to send to? Once filtered down, should all or a sub-set be messaged? Pass a Number to send to that many Peers (picked at random). Passing a zero or negative number for this argument sends to all matched Peers.
* `prop`: (String) Which property of the Peers should be examined?
* `value`: Value of the property the Peers need to match to be included in the set. Matching is done in a case-insensitive way for strings. Passing an array for this argument requires Peers match any one of the array's values.
* `cmd`: (String) Message name to be sent to the Peers
* `payload`: (Buffer) Binary data to be sent to the Peers
* `callback`: (function) If provided, is bound to the "`message`" event of the Peers contacted, to await their reply

```js
Manager.send('all', 'state', 'connected', 'hi', new Buffer([1,2,3,4,5])); // Send a message to all connected clients
Manager.send(2, 'state', 'lonely', 'matchmaker', new Buffer([1,2,3,4,5])); // Send a message to a random two Peers who have state=='lonely'
Manager.send(5, 'myProp', [1,5,42,false], 'hi', new Buffer([1,2,3,4,5])); // Send a message to a random five Peers who have myProp equal to either 1, 5 ,42, or false
```

The function returns an dictionary of Peers the message was sent to, stored by their UUID.

If you're expecting a specific answer to your message, there's a few ways you can listen in:

### Listen to all messages, from just the filtered Peers 
A good method if you expect the answer you seek to be in the next few messages from those Peers:

```js
var m = new Manager();
var waitForAnswer = function(d) {
  if (d.command !== 'answer') return; // Wait for next message...
  
  console.log(d.peer.getUUID()+': has answered', d.data.toString('hex'));
  d.peer.removeListener('message', this); // This listener doesn't care about further messages
  delete peers[d.peer.getUUID()]; // Remove this peer from the list of peers who haven't answered yet
};

var peers = m.send(2, 'state', 'waiting', 'knock', new Buffer([1,2,3]), waitForAnswer);

setTimeout(function() {
  // Ten seconds have passed; give up on those who haven't answered
  for (var uuid in peers) {
    if (peers.hasOwnProperty(uuid)) {
    	console.log(uuid+' never answered...');
      peers[uuid].removeListener('message', waitForAnswer);
    }
  }
}, 10000);
```

### Listen to only answer messages, from all Peers
If there are lots of other messages being sent around, but very few of the particular answer messages you're looking for, this works well:

```js
var m = new Manager();
var waitForAnswer = function(d) {
  // Look through our list of peers and see if d.peer is one of them
  if (peers[d.peer.getUUID()] !== d.peer) return;
  
  console.log(d.peer.getUUID()+': has answered', d.data.toString('hex'));
  delete peers[d.peer.getUUID()]; // Remove this peer from the list of peers who haven't answered yet
};
var peers = m.send(2, 'state', 'waiting', 'knock', new Buffer([1,2,3]));
m.on('answer', waitForAnswer); // Listen in on all 'answer' messages from all peers

setTimeout(function() {
  // Ten seconds have passed; give up on those who haven't answered
  for (var uuid in peers) {
    if (peers.hasOwnProperty(uuid)) {
    	console.log(uuid+' never answered...');
    }
  }
  m.removeListener('answer', waitForAnswer);
}, 10000);
```