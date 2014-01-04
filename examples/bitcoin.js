var Manager = require('../lib/Manager').Manager;
var Message = require('./Message').Message;

var m = new Manager();

process.once('SIGINT', function() {
	console.log('Got SIGINT; closing...');
	process.once('SIGINT', function() {
		// Double SIGINT; force-kill
		process.exit(0);
	});
	m.shutdown();
});

m.handleConnect = function handleConnect(p) {
	// Send VERSION message
	var m = new Message(p.magicBytes, true)
		.putInt32(70000) // version
		.putInt64(1) // services
		.putInt64(Math.round(new Date().getTime()/1000)) // timestamp
		.pad(26) // addr_me
		.pad(26) // addr_you
		.putInt64(self.nonce) // nonce
		.putVarString('Node.js lite peer')
		.putInt32(10); // start_height

	var raw = m.build('version');
	//console.log(raw.toString('hex'));
	p.send(raw);
	p.state = 'awaiting-verack';
	return true;
};

m.versionMessage = function versionMessage(data) {
	var parsed = {};
	parsed.version = data.readUInt32LE(0);
	parsed.services = new Buffer(8);
	data.copy(parsed.services, 0, 4, 12);
	parsed.time = new Buffer(8);
	data.copy(parsed.time, 0, 12, 20);
	parsed.addr_me = getAddr(data.slice(20, 46));
	parsed.addr_you = getAddr(data.slice(46, 72));
	parsed.nonce = new Buffer(8);
	data.copy(parsed.nonce, 0, 72, 80);
	parsed.client = Message.prototype.getVarString(data, 80);
	parsed.height = data.readUInt32LE(data.length-4);
	console.log(parsed);
	
	// Send VERACK message
};

m.verackMessage = function verackMessage(data, p) {
  p.state = 'verack-received';
}

// bitseed.xf2.org
// dnsseed.bluematt.me
// seed.bitcoin.sipa.be
// dnsseed.bitcoin.dashjr.org

m.launch(['dnsseed.bluematt.me']);



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