const qs = require('qs');
const url = require('url');
const http = require('http');
const crypto = require('crypto');
const utils = require('./utils');
const websocket = require('ws');
const debug = require('debug')('hc-proxy')

module.exports = function (u, proxyHeaders) {
  let log = u.log;
  let endpoint = u.endpoint;
  let serviceInfo = url.parse(endpoint);
  let timeout = u.timeout;
  let transform = u.transform;

  return (clientReq, socket, clientHead, proxyUrl) => {
    socket.setTimeout(0);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 0);

    const options = {};
    options.method = 'GET';
    options.timeout = timeout || 0;   // ws 一直连着
    let headers = Object.assign({}, utils.calculateHeaderExtension(clientReq, Object.assign({}, u, u.serviceCfg)), u.headers);
    options.headers = Object.assign(headers, {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Version': clientReq.headers['sec-websocket-version'] || '13',
      'Sec-WebSocket-Key': clientReq.headers['sec-websocket-key'] || crypto.randomBytes(24).toString('base64'),
      'Sec-Websocket-Extensions': clientReq.headers['sec-websocket-extensions'] || 'permessage-deflate; client_max_window_bits'
    });
    // options.protocol = serviceInfo.protocol || 'ws';
    options.hostname = serviceInfo.hostname;
    options.port = serviceInfo.port || 80;

    let defaultQuery = u.defaultQuery instanceof Object ? u.defaultQuery : qs.parse(u.defaultQuery);
    let customerQuery = qs.parse(url.parse(clientReq.url).query);
    options.path = utils.mergeQuery(proxyUrl, defaultQuery, customerQuery);

    const proxyReq = http.request(options);
    proxyReq.on('error', (err) => {
      log.error('ws request error:', err.stack, endpoint + options.path, options);
      socket.end('ws request error');
    });

    proxyReq.on('timeout', function () {
      // It will also emit 'error' after this event.
      log.error('ws request timeout');
      proxyReq.abort();
    });

    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      proxySocket.on('error', function (err) {
        socket.end('');
      });
      // The pipe below will end proxySocket if socket closes cleanly, but not
      // if it errors (eg, vanishes from the net and starts returning
      // EHOSTUNREACH). We need to do that explicitly.
      socket.on('error', function () {
        proxySocket.end();
      });

      proxySocket.setTimeout(0);
      proxySocket.setNoDelay(true);
      proxySocket.setKeepAlive(true, 0);

      if (proxyHead && proxyHead.length) {
        proxySocket.unshift(proxyHead);
      }
      //
      // Remark: Handle writing the headers to the socket when switching protocols
      // Also handles when a header is an array
      //
      let info = Object.keys(proxyRes.headers).reduce(function (head, key) {
        var value = proxyRes.headers[key];

        if (!Array.isArray(value)) {
          head.push(key + ': ' + value);
          return head;
        }

        for (var i = 0; i < value.length; i++) {
          head.push(key + ': ' + value[i]);
        }
        return head;
      }, ['HTTP/1.1 101 Switching Protocols']);

      socket.write(info.join('\r\n') + '\r\n\r\n');
      if (typeof transform === 'function') {
        const receiver = new websocket.Receiver({ isServer: false })
        const Sender = new websocket.Sender(socket);
        receiver.on('message', (message) => {
          try {
            message = transform(message)
            const opts = {
              binary: typeof message !== 'string',
              compress: true,
              fin: true,
            };
            Sender.send(message, opts);
          } catch (e) {
            console.error('error', e);
          }
        })
        receiver.on('ping', (data) => {
          Sender.ping(data);
        });
        receiver.on('pong', (data) => {
          Sender.pong(data);
        });
        receiver.on('conclude', () => {
          proxySocket.end();
          socket.end();
        });
        // 当写入缓冲区变为空时触发
        // receiver.on('drain', (data) => {
        //   console.error(Date.now(), 'drain', data);
        // });
        // 当错误发生时触发
        receiver.on('error', (data) => {
          console.error(Date.now(), 'receiver', data);
          proxySocket.destroy();
          socket.destroy();
        });
        // 当接收到数据的时触发该事件
        socket.on('data', (chunk) => {
          const bool = proxySocket.write(chunk);
          if (!bool) {
            proxySocket.pause();
          }
        });
        // 当 socket 的另一端发送一个 FIN 包的时候触发，从而结束 socket 的可读端
        socket.on('end', () => {
          proxySocket.end();
          socket.end();
        });
        proxySocket.pipe(receiver);
      } else {
        proxySocket.pipe(socket).pipe(proxySocket);
      }
    });
    proxyReq.end();
  };
}
