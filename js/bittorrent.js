(function(){



    var DHT = parseInt('0x01');
    var UTORRENT = parseInt('0x10');
    var NAT_TRAVERSAL = parseInt('0x08');
    var LAST_BYTE = DHT;
    LAST_BYTE |= NAT_TRAVERSAL;


    var FLAGS = [0,0,0,0,0,0,0,0];
    FLAGS[5] = UTORRENT;
    FLAGS[7] = LAST_BYTE;

    window.constants = {
        protocol_name: 'BitTorrent protocol',
        handshake_length: 1 + 'BitTorrent protocol'.length + 8 + 20 + 20,
        std_piece_size: Math.pow(2,14),
        metadata_request_piece_size: Math.pow(2,14),
        messages: [
            'CHOKE',
            'UNCHOKE',
            'INTERESTED',
            'NOT_INTERESTED',
            'HAVE',
            'BITFIELD',
            'REQUEST',
            'PIECE',
            'CANCEL',
            'PORT',
            'WANT_METAINFO',
            'METAINFO',
            'SUSPECT_PIECE',
            'SUGGEST_PIECE',
            'HAVE_ALL',
            'HAVE_NONE',
            'REJECT_REQUEST',
            'ALLOWED_FAST',
            'HOLE_PUNCH',
            '--',
            'UTORRENT_MSG'
        ],
        handshake_flags: FLAGS,
        handshake_code: 0,
        tor_meta_codes: { 0: 'request',
                          1: 'data',
                          2: 'reject' }

    };
    constants.tor_meta_codes_r = reversedict(constants.tor_meta_codes);
    constants.message_dict = {};
    for (var i=0; i<constants.messages.length; i++) {
        constants.message_dict[ constants.messages[i] ] = i;
    }

    function parse_message(ba) {
        // var msg_len = new Uint32Array(ba, 0, 1)[0] - 1; // not correct endianness
        var msg_len = new DataView(ba).getUint32(0) - 1; // equivalent to jspack... use that?

        var msgval = new Uint8Array(ba, 4, 1)[0]; // endianness seems to work ok
        var msgtype = constants.messages[msgval];

        if (ba.byteLength != msg_len + 5) {
            throw Error('bad message length');
        }
        
        return { 'msgtype': msgtype,
                 'msgcode': msgval,
                 'payload': new Uint8Array(ba, 5) };
    }


    function parse_handshake(bytearray) {
        var protocol_str_len = new Uint8Array(bytearray, 0, 1)[0];
        var protocol_str = ab2str(new Uint8Array(bytearray, 1, protocol_str_len + 1));
        var i = 1 + protocol_str_len;

        var reserved = new Uint8Array(bytearray, i, 8);
        i += 8;
        var infohash = new Uint8Array(bytearray, i, 20);
        i += 20;
        var peerid = new Uint8Array(bytearray, i, 20);

        if (bytearray.byteLength != 1 + protocol_str_len + 8 + 20 +20) {
            throw Error('bad handshake '+ data);
        } else {
            return { protocol: protocol_str,
                     reserved: reserved,
                     infohash: ab2hex(infohash),
                     peerid: ab2hex(peerid) };
        }
    }

    var my_peer_id = [];
    for (var i=0; i<20; i++) {
        my_peer_id.push( Math.floor( Math.random() * 256 ) );
    }
    if (my_peer_id.length != 20) { throw Error('bad peer id'); }
    function create_handshake(infohash, peerid) {
        // use binary buffer
        var parts = [constants.protocol_name.length];
        
        parts = parts.concat( _.map(constants.protocol_name.split(''), function(c) { return c.charCodeAt(0); } ) );
        parts = parts.concat( constants.handshake_flags );
        parts = parts.concat( infohash )
        parts = parts.concat( peerid )
        assert(parts.length == 68, 'invalid handshake length');
        return parts


    }

    BitTorrentMessageHandler = Backbone.Model.extend({
        // create handlers for all types of messages?
    });

    var jspack = new JSPack();

    WSPeerConnection = Backbone.Model.extend({
        /* 

           connection that acts like a bittorrent connection, wrapped just inside a websocket

        */
        initialize: function(host, port, infohash, entry) {
            _.bindAll(this, 'onopen', 'onclose', 'onmessage', 'onerror', 'on_connect_timeout',
                      'handle_extension_message',
                      'send_extension_handshake'
                     );

            this.stream = new WebSocket('ws://'+host+':'+port+'/api/upload/ws');
            this.stream.binaryType = "arraybuffer"; // blobs dont have a synchronous API?
            this.infohash = infohash;
            assert(this.infohash.length == 20, 'input infohash as array of bytes');
            this.entry = entry; // upload.btapp.js gives us this...
            this.newtorrent = new NewTorrent({entry:entry});
            console.log('initialize peer connection with infohash',this.infohash);
            this.connect_timeout = setTimeout( this.on_connect_timeout, 1000 );
            this.connected = false;
            this.connecting = true;
            this.handshaking = true;

            this._remote_extension_handshake = null;
            this._my_extension_handshake = null;
            this._sent_extension_handshake = false;

            this.handlers = {
                'UTORRENT_MSG': this.handle_extension_message,
                'PORT': this.handle_port
            };
            this.stream.onopen = this.onopen
            this.stream.onclose = this.onclose
            this.stream.onmessage = this.onmessage
            this.stream.onclose = this.onclose
        },
        send_extension_handshake: function() {
            // woo!!
            var resp = {'v': 'jstorrent 0.0.1',
                        'm': {},
                        'p': 0}; // we don't have a port to connect to :-(
            resp['metadata_size'] = this.entry.get_metadata_size(1024 * 1024); // 1meg piece size
            resp['m']['ut_metadata'] = 2; // totally arbitrary number, but UT needs 2???
            this._my_extension_handshake = resp;
            this._my_extension_handshake_codes = reversedict(resp['m']);

            // build the payload...
            mylog(2, 'sending extension handshake with data',resp);
            var payload = bencode(resp);
            this.send_message('UTORRENT_MSG', [constants.handshake_code].concat(payload));
        },
        send_message: function(type, payload) {
            var len = jspack.Pack('>I', [payload.length+1]);
            var msgcode = constants.message_dict[type]
            var packet = new Uint8Array( len.concat([msgcode]).concat(payload) );
            mylog(1, 'sending message',type,utf8.parse(payload));
            var buf = packet.buffer;
            this.stream.send(buf);
        },
        handle_extension_message: function(data) {
            var ext_msg_type = data.payload[0];
            mylog(1, 'ext msg type', ext_msg_type );
            if (ext_msg_type == constants.handshake_code) {
                var braw = new Uint8Array(data.payload.buffer.slice( data.payload.byteOffset + 1 ));
                mylog(2, 'raw extension message:', braw);
                var info = bdecode( ab2str( braw ) )
                mylog(1, 'decoded extension message stuff',info);

                this._remote_extension_handshake = info;
                this._remote_extension_handshake_codes = reversedict(info['m']);
                if (! this._sent_extension_handshake) {
                    this.send_extension_handshake();
                }
            } else if (this._my_extension_handshake_codes[ext_msg_type]) {
                var ext_msg_str = this._my_extension_handshake_codes[ext_msg_type];
                var their_ext_msg_type = this._remote_extension_handshake['m'][ext_msg_str];

                assert(their_ext_msg_type !== undefined);

                mylog(2, 'handling', ext_msg_str, 'extension message');
                if (ext_msg_str == 'ut_metadata') {
                    mylog(1, 'they are asking for metadata pieces!')
                    var str = utf8.parse(new Uint8Array(data.payload.buffer, data.payload.byteOffset+1));
                    if (str.indexOf('total_size') != -1) {
                        debugger;
                    } else {
                        var info = bdecode(str);
                        var tor_meta_type = constants.tor_meta_codes[ info['msg_type'] ];
                        if (tor_meta_type == 'request') {
                            if (this.entry) {
                                // this is javascript creating the torrent from a file selection or drag n' drop.
                                var metapiece = info.piece;
                                this.newtorrent.register_meta_piece_requested(metapiece);



                                // figure out which pieces this corresponds to...
                                // this.bind('close', function() { this.newtorrent.register_disconnect(metapiece) } );
                            } else {
                                debugger;
                            }
                        } else {
                            debugger;
                        }
                    }
                } else {
                    mylog(1, 'unimplemented extension message', ext_msg_str);
                }
            } else {
                this.shutdown('invalid extension message',data);
                debugger;
            }
        },
        shutdown: function(reason) {
            mylog(1, 'shutting down connection:',reason);
        },
        handle_port: function(data) {
            mylog(1, 'handle port message');
        },
        on_connect_timeout: function() {
            if (! this.connected) {
                this.stream.close();
                this.trigger('timeout');
            }
        },
        onopen: function(evt) {
            clearTimeout( this.connect_timeout );
            // Web Socket is connected, send data using send()
            this.connected = true;
            this.connecting = false;
            console.log(this, "connected!");
            this.trigger('connected'); // send HAVE, unchoke
            this.send_handshake();
        },
        send_handshake: function() {
            var handshake = create_handshake(this.infohash, my_peer_id);
            console.log('sending handshake of len',handshake.length,[handshake])
            var s = new Uint8Array(handshake);
            this.stream.send( s.buffer );
        },
        send: function(msg) {
            this.stream.send(msg);
        },
        handle_message: function(msg) {
            var data = parse_message(msg);
            mylog(2, 'handle message', data.msgtype, data);
            var handler = this.handlers[data.msgtype];
            if (handler) {
                handler(data);
            } else {
                throw Error('unhandled message ' + data.msgtype);
            }
        },
        handle_handshake: function(msg) {
            this.handshaking = false;

            var blob = msg;
            
            var data = parse_handshake(msg);
            console.log('parsed handshake',data)
        },
        onmessage: function(evt) {
            var msg = evt.data;            

            if (this.handshaking) {
                this.handle_handshake(msg);
            } else {
                this.handle_message(msg);
            }

        },
        onclose: function(evt) {
            // websocket is closed.
            console.log("Connection is closed..."); 
        },
        onerror: function(evt) {
            console.error('Connection error');
        }
    });



    var input = 'hello world!';
    var blocksize = 8;
    var h = naked_sha1_head();
    for (var i = 0; i < input.length; i += blocksize) {
        var len = Math.min(blocksize, input.length - i);
        var block = input.substr(i, len);
        naked_sha1(str2binb(block), len*chrsz, h);
    }
    var result = binb2hex(naked_sha1_tail(h));
    assert(result == '430ce34d020724ed75a196dfc2ad67c77772d169');

})();
