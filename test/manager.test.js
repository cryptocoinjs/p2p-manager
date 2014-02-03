var PeerManager = require('../lib/PeerManager').PeerManager;
var Peer = require('p2p-node').Peer;
var assert = require("assert");
var net = require('net');

describe('P2P PeerManager', function() {
  it('should properly connect to indicated host', function(done) {
    var localManager = new PeerManager({listen:false});
    localManager.on('error', function(err) {
      if (err.severity !== 'info' && err.severity !== 'notice') {
        console.log(err);
        assert.ok(false);
      }
    });
    var server = net.createServer(function(socket) {
      server.close();
      localManager.shutdown();
      done();
    });
    server.listen(function() {
      localManager.launch([{host:server.address().address, port:server.address().port}]);
    });
  });
  describe('Messaging', function() {
    var magic = 0x01020304;
    var server = false;
    var localManager = false;
    var serverPeer = false;
    
    beforeEach(function(done) {
      serverPeer = false;
      server = net.createServer(function(socket) {
        serverPeer = new Peer(socket.remoteAddress, socket.remotePort, magic);
        serverPeer.connect(socket);
        done();
      });
      localManager = new PeerManager({listen: false, magic: magic});
      localManager.on('error', function(err) {
        //console.log(err.severity+': '+err.message);
      });
      server.listen(function() {
        localManager.launch([{host:server.address().address, port:server.address().port}]);
      });
    });
    
    afterEach(function() {
      if (serverPeer !== false) serverPeer.destroy();
      server.close();
      if (localManager !== false) localManager.shutdown();
    });
  
    it('should bubble up message events from peers', function(done) {
      var timer = false;
      localManager.on('error', function(err) {
        if (err.severity !== 'info' && err.severity !== 'notice') {
          assert.ok(false);
        }
      });
      localManager.once('message', function(d) {
        assert.equal(d.command, 'hello');
        assert. equal(d.data.toString('utf8'), 'world');
        clearInterval(timer);
        done();
      });
      timer = setInterval(function() {
        serverPeer.send('hello', new Buffer('world', 'utf8'));
      }, 100);
    });
    it('should bubble up command message events from peers', function(done) {
      var timer = false;
      localManager.on('error', function(err) {
        if (err.severity !== 'info' && err.severity !== 'notice') {
          assert.ok(false);
        }
      });
      localManager.once('helloMessage', function(d) {
        assert.equal(d.data.toString('utf8'), 'world');
        clearInterval(timer);
        done();
      });
      timer = setInterval(function() {
        serverPeer.send('hello', new Buffer('world', 'utf8'));
      }, 100);
    });
    it('should send messages to peers', function(done) {
      var timer = false;
      localManager.on('error', function(err) {
        if (err.severity !== 'info' && err.severity !== 'notice') {
          assert.ok(false);
        }
      });
      serverPeer.once('helloMessage', function(d) {
        assert.equal(d.data.toString('utf8'), 'world');
        clearInterval(timer);
        done();
      });
      timer = setInterval(function() {
        localManager.send('all', 'state', 'connected', 'hello', new Buffer('world', 'utf8'));
      }, 100);
    });
  });
  describe('Server listening', function() {
    var magic = 0x01020304;
    var port = 8080;
    var managerServer = new PeerManager({listen:true, magic: magic, port: port});
    var localPeer = false;
    
    managerServer.on('error', function(err) {
      //console.log(err.severity+': '+err.message);
    });
    managerServer.launch([]);

    afterEach(function() {
      if (localPeer !== false) localPeer.destroy();
    });
    
    it('should listen for new peers', function(done) {
      managerServer.once('listenConnect', function(p) {
        done();
      });
      localPeer = new Peer('127.0.0.1', port, magic);
      localPeer.connect();
    });
    it('should receive messages from remote peers', function(done) {
      managerServer.once('helloMessage', function(d) {
        assert.equal(d.data.toString('utf8'), 'world');
        clearInterval(timer);
        done();
      });
      localPeer = new Peer('127.0.0.1', port, magic);
      localPeer.connect();
      timer = setInterval(function() {
        localPeer.send('hello', new Buffer('world', 'utf8'));
      }, 100);
    });
  });
});
