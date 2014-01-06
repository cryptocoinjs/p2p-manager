var PeerManager = require('../lib/PeerManager').PeerManager;
var Message = require('./Message').Message;
var crypto = require('crypto');
var dns = require('dns');

var m = new PeerManager();
// Pick a new random Nonce, to prevent connecting to ourselves
m.nonce = crypto.randomBytes(8);


process.once('SIGINT', function() {
	console.log('Got SIGINT; closing...');
	process.once('SIGINT', function() {
		// Double SIGINT; force-kill
		process.exit(0);
	});
	m.shutdown();
});

m.on('peerConnect', function handleConnect(d) {
	console.log('send bitcoin version message');
	var p = d.peer;
	
	// Send VERSION message
	var m = new Message(p.magicBytes, true)
		.putInt32(70000) // version
		.putInt64(1) // services
		.putInt64(Math.round(new Date().getTime()/1000)) // timestamp
		.pad(26) // addr_recv
		.pad(26) // addr_from
		.putInt64(self.nonce) // nonce
		.putVarString('Node.js lite peer')
		.putInt32(10); // start_height

	var raw = m.build('version');
	//console.log(raw.toString('hex'));
	p.send(raw);
	p.state = 'awaiting-verack';
	return true;
});

// Every message, from every active peer
m.on('peerMessage', function peerMessage(d) {
	console.log(d.peer.getUUID()+': message', d.command, d.data.toString('hex'));
});

// Error messages of various severity, from the PeerManager
m.on('error', function error(d) {
	console.log('('+d.severity+'): '+d.message);
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
	console.log(parsed);
	
	if (parsed.nonce.toString('hex') === this.nonce.toString('hex')) {
		// We connected to ourselves!
		this.disconnect(p);
		return false;
	}
	
	// Send VERACK message
});

// Every 'verack' message, from every active peer
m.on('verackMesasge', function verackMessage(d) {
  d.peer.state = 'verack-received';
});

// bitseed.xf2.org
// dnsseed.bluematt.me
// seed.bitcoin.sipa.be
// dnsseed.bitcoin.dashjr.org

/*
// Resolve DNS seeds
var dnsSeeds = ['bitseed.xf2.org', 'dnsseed.bluematt.me', 'seed.bitcoin.sipa.be', 'dnsseed.bitcoin.dashjr.org'];
var waiting = dnsSeeds.length;
var ipSeeds = [];
for (var i = 0; i < dnsSeeds.length; i++) {
	dns.resolve4(dnsSeeds[i], function(err, addrs) {
		if (err) {
			console.log(err);
		} else {
			ipSeeds = ipSeeds.concat(addrs);
		}
		if (--waiting <= 0) {
			console.log(ipSeeds);
			m.launch(ipSeeds);
		}
	});
};
*/
m.launch('dnsseed.bluematt.me');
//m.addPool(['seed.bitcoin.sipa.be', 'dnsseed.bitcoin.dashjr.org']);



function getAddr(buff) {
	var IPV6_IPV4_PADDING = new Buffer([0,0,0,0,0,0,0,0,0,0,255,255]);
	var addr = {};
	if (buff.length == 30) {
		// with timestamp and services; from ADDR message
		addr.timestamp = buff.readUInt32LE(0);
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