var net = require('net');
var events = require('events');
var util = require('util');
var Peer = require('crypto-p2p-node').Peer;
var Message = require('./Message').Message;

var Manager = exports.Manager = function Manager(options) {
  events.EventEmitter.call(this);

  options = (typeof options === 'undefined')? {} : options;
  var defaultOpts = {
    'useCache': true,
    'listen': true,
    'port': 8333,
    'magic': 0xD9B4BEF9,
    'eternalIP': false
  };
  for (var name in defaultOpts) {
    if (defaultOpts.hasOwnProperty(name) && !options.hasOwnProperty(name)) {
      options[name] = defaultOpts[name];
    }
  }
  
  this.options = options;
  
  this.activePeers = [];
}
util.inherits(Manager, events.EventEmitter);

Manager.prototype.launch = function launch(seedPeers) {
  // Pick a new random Nonce, to prevent connecting to ourselves
  this.nonce = 0x1234;
  
  // Open connections to seed peers
  if (Array.isArray(seedPeers)) {
    for (var i = 0; i < seedPeers.length; i++) {
      this.activePeers.push(this.connect(seedPeers[i]));
    }
  }
  
  self = this;
  process.once('SIGINT', function() {
    console.log('Got SIGINT; closing...');
    for (var i = 0; i < self.activePeers.length; i++) {
      self.activePeers[i].disconnect();
    }
    process.exit(0);
  });
};

Manager.prototype.connect = function connect(host, port) {
  port = (typeof port === 'undefined')? this.options.port : port;
  var p = new Peer(host, port);
  p.magicBytes = this.options.magic;
  
  self = this;
  p.on('connect', function(d) {
    console.log(d.peer.host.host+': connect');
    console.log(d.peer.host.host+' resolved to '+d.peer.socket.remoteAddress+':'+d.peer.socket.remotePort);

    // Send VERSION message
    var m = new Message(p.magicBytes, true);
    m.putInt32(70000); // version
    m.putInt64(1); // services
    m.putInt64(Math.round(new Date().getTime()/1000)); // timestamp
    m.pad(26); // addr_me
    m.pad(26); // addr_you
    m.putInt64(self.nonce); // nonce
    m.putVarString('Node.js lite peer');
    m.putInt32(10); // start_height
  
    var raw = m.build('version');
    //console.log(raw.toString('hex'));
    p.send(raw);
  });
  p.on('end', function(d) {
    console.log(d.peer.host.host+': end');
  });
  p.on('error', function(d) {
    console.log(d.peer.host.host+': error', d.error);
  });
  p.on('message', function(d) {
    console.log(d.peer.host.host+': message', d.command, d.data.toString('hex'));
  });

  p.connect();
  return p;
};