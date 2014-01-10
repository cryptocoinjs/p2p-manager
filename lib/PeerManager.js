var events = require('events');
var net = require('net');
var util = require('util');
var Peer = require('p2p-node').Peer;

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
  this.server = false;
  
  this.poolPeers = [];
  this.badPeers = {};
  
  this.state = 'new';
}
util.inherits(PeerManager, events.EventEmitter);

PeerManager.prototype.launch = function launch(seedPeers) {
  this.state = 'launching';
  
  if (seedPeers !== false) this.addPool(seedPeers); // Open connections to seed peers
  if (this.options.listen) this.openListener(); // Listen for incoming connections
  
  var self = this;
  setImmediate(function() { self.checkPeers(); }); // Attempt to fill remaining peers from pool cache and start timer
  setInterval(function() { self.status(); }, 10*1000).unref(); // Send status message once a minute
};

PeerManager.prototype.openListener = function openListener() {
  var self = this;
  self._error('Opening listening port...', 'info');
  var server = this.server = net.createServer(function(socket) {
    var p = new Peer(socket.remoteAddress, socket.remotePort, self.options.magic);
    
    if (typeof self.activePeers[p.getUUID()] != 'undefined') {
      self._error('Already connected to peer '+p.getUUID()+' yet they contacted us?', 'warning');
      return;
    }
    
    p.on('end', function(d) {
      self.emit('peerEnd', d); // bubble up!
      if (d.peer.state !== 'disconnecting') self._disconnect(d.peer); // Other end hung up on us; no need to hang around
    });
    p.on('error', function(d) {
      self.emit('peerError', d); // bubble up!
      self._warn(d.peer, 10);
      if (d.peer.state !== 'disconnecting') self._disconnect(d.peer); // Close the connection that errored
    });
    p.on('message', function(d) {
      self.emit('message', d); // bubble up!
      self.emit(d.command+'Message', {
        peer: d.peer,
        data: d.data
      });
    });

    p.connect(socket); // Bind to existing socket
    self.activePeers[p.getUUID()] = p;
    self.activePeerCount++;

    if (self.state = 'launching') {
      self.state = 'running'; // First peer to connect updates state
      self.emit('running');
    }
    self.emit('listenConnect', { peer:p });
  });

  server.on('error', function (e) {
    if (e.code == 'EADDRINUSE') {
      self._error('Can\'t open listening on port '+self.options.port+'; port already in use', 'warning');
    }
  });
  server.listen(this.options.port, function() {
    self._error('Now accepting connections on port '+self.options.port, 'info');
  });
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
  // Check for bad peer
  var uuid = host+'~'+port;
  if (typeof this.badPeers[uuid] != 'undefined') {
    // Warning exists; check and see if it's expired
    if ((new Date().getTime() - self.badPeers[uuid].date)/1000/60 > this.badPeers[uuid].warning) {
      delete self.badPeers[uuid]; // Warning expired
    } else {
      return false; // Warning still active
    }
  }
  return [host, port];
};

// Add a new peer to the pool.
// If the number of active peers is below the threshhold, connect to them immediately.
PeerManager.prototype.addPool = function addPool(hosts) {
  if (typeof hosts == 'string') {
    hosts = [hosts];
  }
  var target = (this.state == 'launching')? (this.options.maxPeers + this.options.minPeers)/2 : this.options.minPeers;
  for (var i = 0; i < hosts.length; i++) {
    var rs = this._parseHostList(hosts[i]);
    if (rs === false) continue;
    
    
    if (this.activePeerCount < target) {
      this.addActive(rs[0], rs[1]);
    } else {
      if (typeof this.activePeers[rs[0]+'~'+rs[1]] !== 'undefined') {
        // Already connected to this peer
        continue;
      }
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
    
    if (typeof this.activePeers[rs[0]+'~'+rs[1]] !== 'undefined') {
      // Already connected to this peer
      continue;
    }

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
    if (self.state = 'launching') {
      self.state = 'running'; // First peer to connect updates state
      self.emit('running');
    }
    self.emit('peerConnect', d); // bubble up!
  });
  p.on('end', function(d) {
    self.emit('peerEnd', d); // bubble up!
    if (d.peer.state !== 'disconnecting') self._disconnect(d.peer); // Other end hung up on us; no need to hang around
  });
  p.on('error', function(d) {
    self.emit('peerError', d); // bubble up!
    self._warn(d.peer, 10);
    if (d.peer.state !== 'disconnecting') self._disconnect(d.peer); // Close the connection that errored
  });
  p.on('message', function(d) {
    self.emit('message', d); // bubble up!
    self.emit(d.command+'Message', {
      peer: d.peer,
      data: d.data
    });
  });

  setImmediate(function() {
    self._error('Attempting to connect to '+p.getUUID(), 'notice');
    p.connect();
    p.state = 'connecting';
    setTimeout(function() { // Give them a few seconds to respond, otherwise close the connection automatically
      if (p.state == 'connecting') {
        p.state = 'closed';
        self._warn(p, 10);
        self.delActive(p, 'didn\'t respond to connection attempt; force-closing');
      }
    }, 5*1000).unref();
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
  this.emit('status', {
    'numActive': this.activePeerCount,
    'poolSize': this.poolPeers.length,
    'badPeers': this.badPeers
  });
};

PeerManager.prototype.send = function send(number, property, values, cmd, payload, answer, callback) {
  if (number == false || number < 0) number = 'all';
  if (!Array.isArray(values)) values = [values];
  if (typeof payload == 'undefined') payload = new Buffer(0);

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
  if (uuids.length == 0) return false; // None matched that filter
  
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
  var picked = 0;
  while (picked < number) {
    var uuid = uuids.pop();
    var p = this.activePeers[uuid];
    if (typeof p !== 'undefined') { // Ensure it hasn't closed in the gap
      toSend[uuid] = p;
      picked++;
    }
    if (uuids.length == 0) break; // No more to parse
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

PeerManager.prototype.delActive = function delActive(p, reason) {
  var self = this;
  if (typeof this.activePeers[p.getUUID()] == 'undefined') return; // We weren't connected to them in the first place
  if (p.state != 'disconnecting' && p.state != 'disconnected' && p.state != 'closed') {
    if (typeof reason == 'string') {
      this._error('Disconnecting from '+p.getUUID()+' ('+p.state+'); '+reason, 'info');
    } else {
      this._error('Disconnecting from '+p.getUUID()+' ('+p.state+')', 'info');
    }
    return this._disconnect(p); // Hang up first, then delete
  }
  
  p.destroy();
  delete this.activePeers[p.getUUID()];
  this.activePeerCount--;
  if (typeof reason == 'string') {
    this._error(p.getUUID()+' closed; '+reason+'. '+this.activePeerCount+' active peers now', 'info');
  } else {
    this._error(p.getUUID()+' closed; '+this.activePeerCount+' active peers now', 'info');
  }
  
  if (this.state == 'shutdown') return; // Don't attempt to add more peers if in shutdown mode
  setImmediate(function() { self.checkPeers(); });
};

PeerManager.prototype._warn = function _warn(p, mins) {
  if (typeof this.badPeers[p.getUUID()] != 'undefined') {
    // Already has a warning; see if it's expired
    var warningRemaining = this.badPeers[p.getUUID()].warning - ((new Date().getTime() - this.badPeers[p.getUUID()].date)/1000/60);
    if (warningRemaining < 0) warningRemaining = 0;
    // Add new warning to the old
    this.badPeers[p.getUUID()].warning = warningRemaining + mins;
    this.badPeers[p.getUUID()].date = new Date().getTime();
  } else {
    this.badPeers[p.getUUID()] = {
      host: p.host.host,
      port: p.host.port,
      date: new Date().getTime(),
      warning: mins
    };
  }
};

// Internal function; don't call directly. Use delActive instead.
PeerManager.prototype._disconnect = function _disconnect(p) {
  var self = this;
  p.state = 'disconnecting';
  p.once('close', function(d) {
    self.delActive(d.peer, 'remote connection closed');
  });
  p.disconnect();
  // Give them a few seconds to close out, otherwise we'll just delete
  setTimeout(function() {
    if (self.activePeers[p.getUUID()] == p) {
      // Hasn't been deleted yet
      self._error(p.getUUID()+' didn\'t close on their own; force-closing', 'notice');
      p.destroy(); // Triggers a 'close' event, so the above listener will fire
    }
  }, 5*1000).unref();
};

PeerManager.prototype.shutdown = function shutdown() {
  this.state = 'shutdown';
  if (this.server !== false) {
    this.server.close();
  }
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
