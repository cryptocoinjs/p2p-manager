var PeerManager = require('../lib/PeerManager').PeerManager;
var Message = require('./Message').Message;
var crypto = require('crypto');
var dns = require('dns');

var m = new PeerManager();
// Pick a new random Nonce, to prevent connecting to ourselves
m.nonce = crypto.randomBytes(8);

var managerReady = false;

process.once('SIGINT', function() {
	console.log('Got SIGINT; closing...');
	process.once('SIGINT', function() {
		// Double SIGINT; force-kill
		process.exit(0);
	});
	m.shutdown();
});

// Every message, from every active peer
m.on('peerMessage', function peerMessage(d) {
	console.log(d.peer.getUUID()+': message', d.command, d.data.toString('hex'));
});

// Error messages of various severity, from the PeerManager
m.on('error', function error(d) {
	console.log('('+d.severity+'): '+d.message);
});

m.on('status', function status(d) {
  console.log('PeerManager status:', d);
});

// Every 'version' message, from every active peer
m.on('versionMessage', function versionMessage(d) {
	var data = d.data;
	var parsed = {};
	parsed.version = data.readUInt32LE(0);
	parsed.services = new Buffer(8);
	data.copy(parsed.services, 0, 4, 12);
	parsed.time = new Buffer(8);
	data.copy(parsed.time, 0, 12, 20);
	parsed.addr_recv = getAddr(data.slice(20, 46));
	parsed.addr_from = getAddr(data.slice(46, 72));
	parsed.nonce = new Buffer(8);
	data.copy(parsed.nonce, 0, 72, 80);
	parsed.client = Message.prototype.getVarString(data, 80);
	parsed.height = data.readUInt32LE(data.length-4);
	console.log('VERSION:', parsed);
	
	if (parsed.nonce.toString('hex') === m.nonce.toString('hex')) {
		// We connected to ourselves!
		m.delActive(p);
		return false;
	}
	
	// Send VERACK message
  d.peer.send('verack');
});

// Every 'verack' message, from every active peer
m.on('verackMessage', function verackMessage(d) {
  d.peer.state = 'verack-received';
  if (managerReady === false) {
    managerReady = true; // At least one peer now has responded
    setTimeout(managerInit, 2*1000); // Do initialization stuff after a few seconds, to let others connect too
  }
});

m.on('listenConnect', function(d) {
  console.log('Inbound connection from '+d.peer.getUUID());
  var watchdog = setTimeout(function() {
    // No VERSION message received
    m.delActive(d.peer, 'No VERSION message received from remote peer');
  }, 10*1000);
  watchdog.unref();
  d.peer.once('versionMessage', function(d) {
    // VERSION message received
    console.log('VERSION message received');
    clearTimeout(watchdog);
  });
});

m.launch([]);

var managerInit = function managerInit() {
  console.log('Initializing communications:');
}



function getAddr(buff) {
	var IPV6_IPV4_PADDING = new Buffer([0,0,0,0,0,0,0,0,0,0,255,255]);
	var addr = {};
	if (buff.length == 30) {
		// with timestamp and services; from ADDR message
		addr.timestamp = new Date(buff.readUInt32LE(0)*1000);
		addr.services = new Buffer(8);
		buff.copy(addr.services, 0, 4, 12);
		addr.host = getHost(buff.slice(12, 28));
		addr.port = buff.readUInt16BE(28);
	}	if (buff.length == 26) {
		// with services, no time; from VERSION message
		addr.services = new Buffer(8);
		buff.copy(addr.services, 0, 0, 8);
		addr.host = getHost(buff.slice(8, 24));
		addr.port = buff.readUInt16BE(24);
	} else if (buff.length == 18) {
	  // IP and port alone
		addr.host = getHost(buff.slice(0, 16));
		addr.port = buff.readUInt16BE(16);
	}
	return addr;
	
	function getHost(buff) {
		if (buff.slice(0, 12).toString('hex') != IPV6_IPV4_PADDING.toString('hex')) {
			// IPv6
			return buff.toString('hex')
				.match(/(.{1,4})/g)
				.join(':')
				.replace(/\:(0{2,4})/g, ':0')
				.replace(/^(0{2,4})/g, ':0');
		} else {
			// IPv4
			return Array.prototype.join.apply(buff.slice(12), ['.']);
		}
	}
};