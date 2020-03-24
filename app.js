var colyseus = require('colyseus')
  , ServerIO = require('./server')
  , http = require('http')
  , express = require('express')
  , port = process.env.PORT || 2657
  , app = express();

var server = http.createServer(app)
  , gameServer = new colyseus.Server({ server: server })

gameServer.register('crash', ServerIO)


server.listen(port);

console.log(`Listening on http://localhost:${port}`)