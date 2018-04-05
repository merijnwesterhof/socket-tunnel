module.exports = function(options) {
    // libs
    var http = require('http');
    var tldjs = require('tldjs');
    var ss = require('socket.io-stream');
    var uuid = require('uuid/v4');

    // association between subdomains and socket.io sockets
    var socketsByName = {};
    // association between subdomains and streams
    var streamsByName = {};

    // bounce incoming http requests to socket.io
    var server = http.createServer(function (req, res) {
        // without a hostname, we won't know who the request is for
        var hostname = req.headers.host;
        if (!hostname) {
            res.statusCode = 502;
            return res.end('Invalid hostname');
        }

        // make sure we received a subdomain
        var subdomain = tldjs.getSubdomain(hostname);
        if (!subdomain) {
            res.statusCode = 502;
            return res.end('Invalid subdomain');
        }

        // tldjs library return subdomain as all subdomain path from the main domain.
        // Example:
        // 1. super.example.com = super
        // 2. my.super.example.com = my.super
        // If want to run tunnel server on subdomain, then must use option serverSubdomainHost
        // and correctly trim returned subdomain by tldjs
        if (options['subdomain']) {
            subdomain = subdomain.replace('.' + options['subdomain'], '');
        }

        var clientId = subdomain.toLowerCase();
        var client = socketsByName[clientId];

        // no such subdomain
        // we use a 502 error to the client to signify we can't service the request
        if (!client) {
            res.statusCode = 502;
            res.end(clientId + ' is currently unregistered or offline.');
        } else {
            var requestGUID = uuid();

            client.emit('incomingClient', requestGUID);

            ss(client).once(requestGUID, function (stream) {
            	streamsByName[clientId] = stream;
                stream.on('error', function () {
                    req.destroy();
                    stream.destroy();
                });

                // Pipe all data from tunnel stream to requesting connection
                stream.pipe(req.connection);

                var postData = [];

                // Collect data of POST/PUT request to array buffer
                req.on('data', function(data) {
                    postData.push(data);
                });

                // Proxy ended GET/POST/PUT/DELETE request to tunnel stream
                req.on('end', function() {
                    var messageParts = [];

                    // Push request data
                    messageParts.push([req.method + ' ' + req.url + ' HTTP/' + req.httpVersion]);

                    // Push headers data
                    for (var i = 0; i < (req.rawHeaders.length-1); i += 2) {
                        messageParts.push(req.rawHeaders[i] + ': ' + req.rawHeaders[i+1]);
                    }
                    // Push delimiter
                    messageParts.push('');

                    // Push request body data
                    messageParts.push(Buffer.concat(postData).toString());

                    // Push delimiter
                    messageParts.push('');

                    var message = messageParts.join('\r\n');

                    stream.write(message);
                });
            });
        }
    });
    server.on('upgrade', (req, socket, head) => {
        // without a hostname, we won't know who the request is for
        var hostname = req.headers.host;
    	// console.log('server upgrade event. hostname',hostname);
        if (!hostname) {
        	console.log('Error: no hostname');
        }

        // make sure we received a subdomain
        var subdomain = tldjs.getSubdomain(hostname);
        if (!subdomain) {
        	console.log('Error: no subdomain');
        }

        // tldjs library return subdomain as all subdomain path from the main domain.
        // Example:
        // 1. super.example.com = super
        // 2. my.super.example.com = my.super
        // If want to run tunnel server on subdomain, then must use option serverSubdomainHost
        // and correctly trim returned subdomain by tldjs
        if (options['subdomain']) {
            subdomain = subdomain.replace('.' + options['subdomain'], '');
        }

        var clientId = subdomain.toLowerCase();
        var client = socketsByName[clientId];

        // no such subdomain
        if (!client) {
        	console.log('Error: no client');
        } 
        else if(!streamsByName[clientId]){
        	console.log('Error: no stream');
        }
        else {
        	var stream = streamsByName[clientId]; // use the same stream created earlier
        	console.log('server upgrade event with clientId:',clientId);

        	// For normal requests this code was implemented like above. Is this needed for upgrade-events as well?
            // // Pipe all data from tunnel stream to requesting connection
            // stream.pipe(req.connection);
            // stream.pipe(req.connection, { end: false });

        	// from https://github.com/localtunnel/server/blob/master/lib/ClientManager.js starting on line 161, adapted for use through SocketTunnel
            if (!socket.readable || !socket.writable) {
        		console.log('Error: socket not readable or writable');
                socket.end();
                return;
            }

        	// console.log('server upgrade req:',req,'and socket:',socket,'and head:',head);
            const arr = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
            for (let i=0 ; i < (req.rawHeaders.length-1) ; i+=2) {
                arr.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i+1]}`);
            }

            arr.push('');
            arr.push('');
            var message = arr.join('\r\n');

            stream.write(message);
        	console.log('Message sent');

            return;
        }
        // from https://github.com/localtunnel/server/blob/master/server.js starting on line 132
        // if (!hostname) {
        //     sock.destroy();
        //     return;
        // }

        // const clientId = GetClientIdFromHostname(hostname);
        // if (!clientId) {
        //     sock.destroy();
        //     return;
        // }

        // if (manager.hasClient(clientId)) {
        //     manager.handleUpgrade(clientId, req, socket);
        //     return;
        // }

        socket.destroy();
    });

    // socket.io instance
    var io = require('socket.io')(server);
    io.on('connection', function (socket) {
        socket.on('createTunnel', function (requestedName) {
            if (socket.requestedName) {
                // tunnel has already been created
                return;
            }

            // domains are case insensitive
            var reqNameNormalized = requestedName.toLowerCase();

            // make sure the client is requesting an alphanumeric of reasonable length
            if (/[^a-zA-Z0-9]/.test(reqNameNormalized) || reqNameNormalized.length === 0 || reqNameNormalized.length > 63) {
                console.log(new Date() + ': ' + reqNameNormalized + ' -- bad subdomain. disconnecting client.');
                return socket.disconnect();
            }

            // make sure someone else hasn't claimed this subdomain
            if (socketsByName[reqNameNormalized]) {
                console.log(new Date() + ': ' + reqNameNormalized + ' requested but already claimed. disconnecting client.');
                return socket.disconnect();
            }

            // store a reference to this socket by the subdomain claimed
            socketsByName[reqNameNormalized] = socket;
            socket.requestedName = reqNameNormalized;
            console.log(new Date() + ': ' + reqNameNormalized + ' registered successfully');
        });

        // when a client disconnects, we need to remove their association
        socket.on('disconnect', function () {
            if (socket.requestedName) {
                delete socketsByName[socket.requestedName];
                console.log(new Date() + ': ' + socket.requestedName + ' unregistered');
            }
        });
    });

    // http server
    server.listen(options['port'], options['host']);

    console.log(new Date() + ': socket-tunnel server started on port ' + options['port']);
};
