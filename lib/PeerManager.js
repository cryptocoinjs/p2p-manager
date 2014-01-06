var events = require('events');
var util = require('util');
var Peer = require('crypto-p2p-node').Peer;

var PeerManager = exports.PeerManager = function PeerManager(options) {
  events.EventEmitter.call(this);

  options = (typeof options === 'undefined')? {} : options;
  var defaultOpts = {
    'useCache': true,
    'listen': true,
    'port': 8333,
    'magic': 0xD9B4BEF9,
    'minPeers': 3,
    'maxPeers': 20,
    'idleTimeout': 30*60*1000 // time out peers we haven't heard anything from in 30 minutes
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
util.inherits(PeerManager, events.EventEmitter);

PeerManager.prototype.launch = function launch(seedPeers) {
  this.state = 'launching';
  
  if (seedPeers !== false) this.addPool(seedPeers); // Open connections to seed peers
  var self = this;
  setImmediate(function() { self.checkPeers(); }); // Attempt to fill remaining peers from pool cache and start timer
  setInterval(function() { self.status(); }, 60*1000).unref(); // Send status message once a minute
  
  this.state = 'running';
};

PeerManager.prototype._parseHostList = function _parseHostList(elem) {
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
PeerManager.prototype.addPool = function addPool(hosts) {
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

PeerManager.prototype.addActive = function addActive(hosts) {
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
PeerManager.prototype._connect = function _connect(host, port) {
  port = (typeof port === 'undefined')? this.options.port : port;
  var p = new Peer(host, port, this.options.magic);
  
  self = this;
  p.on('connect', function(d) {
    //console.log(d.peer.host.host+' resolved to '+d.peer.socket.remoteAddress+':'+d.peer.socket.remotePort);
    
    self.emit('peerConnect', d); // bubble up!
  });
  p.on('end', function(d) {
    console.log(d.peer.host.host+': end');

    self.emit('peerEnd', d); // bubble up!
    if (d.peer.state !== 'disconnecting') self._disconnect(d.peer); // Other end hung up on us; no need to hang around
  });
  p.on('error', function(d) {
    console.log(d.peer.host.host+': error', d.error);
    
    self.emit('peerError', d); // bubble up!
    if (d.peer.state !== 'disconnecting') self._disconnect(d.peer); // Close the connection that errored
  });
  p.on('message', function(d) {
    self.emit('peerMessage', d); // bubble up!
    self.emit(d.command+'Message', {
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

// Periodic function that checks the status of the peer network being managed
PeerManager.prototype.checkPeers = function checkPeers() {
  if (this.state == 'shutdown') return;
  
  // First reset our own timer
  var self = this;
  clearTimeout(this.fillTimeout); // If we were called early, reset the existing one
  this.fillTimeout = setTimeout(function() { self.checkPeers(); }, 60*1000);
  this.fillTimeout.unref(); // If this timer is the only thing going, don't keep program open just for it
  
  // Timeout peers that have been quiet for too long
  for (var uuid in this.activePeers) {
    if (this.activePeers.hasOwnProperty(uuid) && this.activePeers[uuid].lastSeen !== false && this.activePeers[uuid].lastSeen.getTime() < new Date().getTime() - this.options.idleTimeout) {
      this._error(uuid+' has been quiet too long; disconnecting', 'info');
      this._disconnect(this.activePeers[uuid]);
    }
  }
  
  // Ensure minimum number of active peers are set
  if (this.activePeerCount < this.options.minPeers) {
    this._error('Too few active peers ('+this.activePeerCount+' < '+this.options.minPeers+'); pulling more from pool', 'info');
    while (this.activePeerCount < this.options.minPeers) {
      if (this.poolPeers.length == 0) {
        this._error('No more pooled peers...', 'info');
        return;
      }
    
      var peer = this.poolPeers.shift();
      this.addActive(peer.host, peer.port); // Synchronously queues up a Peer to be connected, and increments activePeerCount, so this while loop works
    }
  }
  
  // Warn if more than maximum is set
  if (this.activePeerCount > this.options.maxPeers) {
    this._error('Number of active peers above the maximum ('+this.activePeerCount+' > '+this.options.maxPeers+'); find a way to determine which should be disconnected, and call delActive() on them.');
  }
};

PeerManager.prototype.status = function status() {
  if (this.state == 'shutdown') return;
  this.emit('status', {
    'numActive': this.activePeerCount,
    'poolSize': this.poolPeers.length
  });
};

PeerManager.prototype.send = function send(number, property, values, cmd, payload, answer, callback) {
  if (number == false || number < 0) number = 'all';
  if (!Array.isArray(values)) values = [values];

  // Build a sub-set of items
  var uuids = [];
  for (var uuid in this.activePeers) {
    if (this.activePeers.hasOwnProperty(uuid)) {
      for (var i = 0; i < values.length; i++) {
        if (this.activePeers[uuid][property] == values[i]) {
          uuids.push(uuid);
          break;
        }
      }
    }
  }
  
  // Shuffle
  var i = uuids.length, randomIndex, temp;
  while (0 !== i) {
    // Pick a remaining element...
    randomIndex = Math.floor(Math.random() * i);
    i--;

    // And swap it with the current element.
    temp = uuids[i];
    uuids[i] = uuids[randomIndex];
    uuids[randomIndex] = temp;
  }
  
  var toSend = {};
  if (number == 'all') number = uuids.length;
  for (i = 0; i < number; i++) {
    toSend[uuids[i]] = this.activePeers[uuids[i]];
  }
  
  // now send to toSend:
  for (var uuid in toSend) {
    if (toSend.hasOwnProperty(uuid)) {
      toSend[uuid].send(cmd, payload);
      if (typeof callback == 'function') {
        toSend[uuid].on(answer, callback);
      }
    }
  }
  return toSend;  
};

PeerManager.prototype.delActive = function delActive(p) {
  var self = this;
  if (typeof this.activePeers[p.getUUID()] == 'undefined') return; // We weren't connected to them in the first place
  if (p.state != 'disconnecting' && p.state != 'disconnected' && p.state != 'closed') {
    self._error(p.getUUID()+' is state '+p.state+', disconnecting first', 'notice');
    return this._disconnect(p); // Hang up first, then delete
  }
  
  p.destroy();
  delete this.activePeers[p.getUUID()];
  this.activePeerCount--;
  
  this._error(p.getUUID()+' closed; '+this.activePeerCount+' active peers now');
  
  if (this.state == 'shutdown') return; // Don't attempt to add more peers if in shutdown mode
  setImmediate(function() { self.checkPeers(); });
};

// Internal function; don't call directly. Use delActive instead.
PeerManager.prototype._disconnect = function _disconnect(p) {
  var self = this;
  p.state = 'disconnecting';
  p.once('close', function(d) {
    self._error(d.peer.getUUID()+' is now closed', 'notice');
    self.delActive(d.peer);
  });
  p.disconnect();
};

PeerManager.prototype.shutdown = function shutdown() {
  this.state = 'shutdown';
  for (var uuid in this.activePeers) {
    if (this.activePeers.hasOwnProperty(uuid) && this.activePeers[uuid] instanceof Peer) {
      this._error('Disconnecting '+uuid, 'notice');
      this._disconnect(this.activePeers[uuid]);
    }
  }
};

// Trigger an error message. Severity is one of 'info', 'notice', 'warning', or 'error' (in increasing severity)
PeerManager.prototype._error = function _error(message, severity) {
  severity = severity || 'warning';
  this.emit('error', {
    severity: severity,
    message: message
  });
};
