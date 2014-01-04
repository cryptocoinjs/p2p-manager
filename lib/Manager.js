var events = require('events');
var util = require('util');
var Peer = require('crypto-p2p-node').Peer;

var Manager = exports.Manager = function Manager(options) {
  events.EventEmitter.call(this);

  options = (typeof options === 'undefined')? {} : options;
  var defaultOpts = {
    'useCache': true,
    'listen': true,
    'port': 8333,
    'magic': 0xD9B4BEF9
  };
  for (var name in defaultOpts) {
    if (defaultOpts.hasOwnProperty(name) && !options.hasOwnProperty(name)) {
      options[name] = defaultOpts[name];
    }
  }
  
  this.options = options;
  
  this.activePeers = {};
}
util.inherits(Manager, events.EventEmitter);

Manager.prototype.launch = function launch(seedPeers) {
  // Pick a new random Nonce, to prevent connecting to ourselves
  this.nonce = 0x1234;
  
  // Open connections to seed peers
  if (Array.isArray(seedPeers)) {
    for (var i = 0; i < seedPeers.length; i++) {
    	var p = this.connect(seedPeers[i]);
    	self.activePeers[p.getUUID()] = p;
    }
  }
  
  self = this;
  process.once('SIGINT', function() {
    console.log('Got SIGINT; closing...');
    for (var uuid in self.activePeers) {
    	if (self.activePeers.hasOwnProperty(uuid) && self.activePeers[uuid] instanceof Peer) {
    		console.log('Disconnecting '+uuid);
	      self.activePeers[uuid].disconnect();
	    }
    }
    process.exit(0);
  });
};

Manager.prototype.connect = function connect(host, port) {
  port = (typeof port === 'undefined')? this.options.port : port;
  var p = new Peer(host, port, this.options.magic);
  
  self = this;
  p.once('connect', function(d) {
    console.log(d.peer.host.host+': connect');
    console.log(d.peer.host.host+' resolved to '+d.peer.socket.remoteAddress+':'+d.peer.socket.remotePort);
    
    if (typeof self.handleConnect === 'function') {
			var rs = self.handleConnect(d.peer);
			if (rs === false) self.disconnect(d.peer);
		}
  });
  p.once('end', function(d) {
    console.log(d.peer.host.host+': end');

    if (typeof self.handleEnd === 'function') {
			var rs = self.handleEnd(d.peer);
		}
		self.disconnect(d.peer); // Other end hung up on us; no need to hang around
  });
  p.on('error', function(d) {
    console.log(d.peer.host.host+': error', d.error);

    if (typeof self.handleError === 'function') {
			self.handleError(d.peer);
		}
  });
  p.on('message', function(d) {
    console.log(d.peer.host.host+': message', d.command, d.data.toString('hex'));
		for (var prop in self) {
		  if (self.hasOwnProperty(prop) && typeof self[prop] == 'function' && prop == d.command+'Message') {
		  	var rs = self[prop](d.data);
		  	if (rs === false) {
		  		// Stop execution
		  		return;
		  	} else {
		  		// Also trigger an event
		  		break;
		  	}
		  }
		}
		
		// No handler found; send it as a message.
		this.emit(d.command, {
			peer: d.peer,
			data: d.data
	  });
  });

  p.connect();
  return p;
};

Manager.prototype.disconnect = function disconnect(p) {
	var self = this;
	p.once('close', function(d) {
		console.log(d.peer.host.host+' is now closed');
		delete self.activePeers[p.getUUID()];
	});
	p.disconnect();
};