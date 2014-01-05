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
    'magic': 0xD9B4BEF9,
    'minPeers': 3,
    'maxPeers': 20
  };
  for (var name in defaultOpts) {
    if (defaultOpts.hasOwnProperty(name) && !options.hasOwnProperty(name)) {
      options[name] = defaultOpts[name];
    }
  }
  options.port = parseInt(options.port);
  options.magic = parseInt(options.magic);
  options.minPeers = parseInt(options.minPeers);
  options.maxPeers = parseInt(options.maxPeers);
  
  this.options = options;
  
  this.activePeers = {};
  this.activePeerCount = 0;
  
  this.poolPeers = [];
  
  this.state = 'new';
}
util.inherits(Manager, events.EventEmitter);

Manager.prototype.launch = function launch(seedPeers) {
  this.state = 'launching';
  
  if (seedPeers !== false) this.addActive(seedPeers); // Open connections to seed peers
  var self = this;
  setImmediate(function() { self.fillActive(); }); // Attempt to fill remaining peers from pool cache and start timer
  
  this.state = 'running';
};

Manager.prototype._parseHostList = function _parseHostList(elem) {
  var host, port;
  if (typeof elem == 'string') {
    host = elem;
    port = this.options.port;
  } else if (Array.isArray(elem)) {
    host = elem[0];
    port = (elem.length > 1)? elem[1] : this.options.port;
  } else if (typeof elem == 'object' && typeof elem.host !== 'undefined') {
    host = elem.host;
    port = (typeof elem.port !== 'undefined')? elem.port : this.options.port;
  } else {
    return false;
  }
  return [host, port];
};

// Add a new peer to the pool.
// If the number of active peers is below the threshhold, connect to them immediately.
Manager.prototype.addPool = function addPool(hosts) {
  if (typeof hosts == 'string') {
    hosts = [hosts];
  }
  for (var i = 0; i < hosts.length; i++) {
    var rs = this._parseHostList(hosts[i]);
    if (rs === false) continue;
    
    if (this.activePeerCount < this.options.minPeers) {
      this.addActive(rs[0], rs[1]);
    } else {
      this.poolPeers.push({host: rs[0], port: rs[1]});
    }
  }
  
  // De-duplicate poolPeers
  var unique = {};
  var distinct = [];
  this.poolPeers.forEach(function (peer) {
    var id = peer.host+'~'+peer.port;
    if (!unique[id]) {
      distinct.push(peer);
      unique[id] = true;
    }
  });
  this.poolPeers = distinct;
  
  return true;
}

Manager.prototype.addActive = function addActive(hosts) {
  if (typeof hosts == 'string') {
    hosts = [hosts];
  }
  for (var i = 0; i < hosts.length; i++) {
    var rs = this._parseHostList(hosts[i]);
    if (rs === false) continue;

    var p = this._connect(rs[0], rs[1]);
    this.activePeers[p.getUUID()] = p;
    this.activePeerCount++;
  }
}

// Internal function; don't call directly. Use addPool or addActive instead.
Manager.prototype._connect = function _connect(host, port) {
  port = (typeof port === 'undefined')? this.options.port : port;
  var p = new Peer(host, port, this.options.magic);
  p.state = 'new';
  
  self = this;
  p.once('connect', function(d) {
    console.log(d.peer.host.host+': connect');
    console.log(d.peer.host.host+' resolved to '+d.peer.socket.remoteAddress+':'+d.peer.socket.remotePort);
    d.peer.state = 'connected';
    
    if (typeof self.handleConnect === 'function') {
      var rs = self.handleConnect(d.peer);
      if (rs === false) self._disconnect(d.peer);
    }
  });
  p.once('end', function(d) {
    console.log(d.peer.host.host+': end');

    if (typeof self.handleEnd === 'function') {
      var rs = self.handleEnd(d.peer);
    }
    if (d.peer.state !== 'disconnecting') self._disconnect(d.peer); // Other end hung up on us; no need to hang around
  });
  p.on('error', function(d) {
    console.log(d.peer.host.host+': error', d.error);

    if (typeof self.handleError === 'function') {
      self.handleError(d.peer);
    }
    if (d.peer.state !== 'disconnecting') self._disconnect(d.peer); // Close the connection that errored
  });
  p.on('message', function(d) {
    console.log(d.peer.host.host+': message', d.command, d.data.toString('hex'));
    for (var prop in self) {
      if (self.hasOwnProperty(prop) && typeof self[prop] == 'function' && prop == d.command+'Message') {
        var rs = self[prop](d.data, d.peer);
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

  setImmediate(function() {
    p.connect();
    p.state = 'connecting';
  });
  return p; // delay p.connect() using setImmediate, so that whatever is receiving this return value can prepare for the connection before it happens
};

Manager.prototype.fillActive = function fillActive() {
  if (this.activePeerCount >= this.options.minPeers) {
    // No action needed now; delay for a minute and check again
    clearTimeout(this.fillTimeout);
    this.fillTimeout = setTimeout(this.fillActive, 60*1000);
    this.fillTimeout.unref(); // If this timer is the only thing going, don't keep program open just for it
    return;
  }
  console.log('Too few active peers ('+this.activePeerCount+' < '+this.options.minPeers+'); pulling more from pool');

  while (this.activePeerCount < this.options.minPeers) {
    if (this.poolPeers.length == 0) {
      console.log('No more pooled peers...');
      return;
    }
    
    var peer = this.poolPeers.shift();
    this.addActive(peer.host, peer.port); // Synchronously queues up a Peer to be connected, and increments activePeerCount, so this while loop works
  }
};

Manager.prototype.delActive = function delActive(p) {
  delete this.activePeers[p.getUUID()];
  this.activePeerCount--;
  
  if (this.state = 'shutdown') return; // Don't attempt to add more peers if in shutdown mode
  var self = this;
  setImmediate(function() { self.fillActive(); });
};

// Internal function; don't call directly. Use delActive instead.
Manager.prototype._disconnect = function _disconnect(p) {
  var self = this;
  p.state = 'disconnecting';
  p.once('close', function(d) {
    console.log(d.peer.host.host+' is now closed');
    self.delActive(d.peer);
  });
  p.disconnect();
};

Manager.prototype.shutdown = function shutdown() {
  this.state = 'shutdown';
  for (var uuid in this.activePeers) {
    if (this.activePeers.hasOwnProperty(uuid) && this.activePeers[uuid] instanceof Peer) {
      console.log('Disconnecting '+uuid);
      this._disconnect(this.activePeers[uuid]);
    }
  }
};
