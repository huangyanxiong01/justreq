'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const cache = require('./cache');
const xecho = require('./xecho');
const mime = require('./mimetype');
const html = require('./html');
const {parseExpires} = require('./utils');

class Proxy {
  constructor(opt, req, res, cacheFileName, chunk) {
    this.host = opt.host;
    this.port = opt.port;
    this.onHttps = opt.proxyHttps==='auto' ? opt.port==443 : opt.proxyHttps==='yes';
    this.onCors = opt.onCors;

    let head = Object.assign({}, req.headers, {'accept-encoding': 'gzip,deflate'});
    head.host = this.host;
    delete head['if-modified-since'];
    delete head['if-none-match'];
    html.init(opt);

    this.options = {
      hostname: this.host,
      port: this.port,
      path: req.url,
      method: req.method,
      agent: false,
      headers: head 
    };
    this.loadSslOptions(opt);

    this.cachePath = cacheFileName ? path.resolve(opt.cachePath, cacheFileName) : '';
    this.cltRes = res;
    this.socket = this.onHttps ? https.request(this.options) : http.request(this.options);
    this.socket.on('socket', ()=>{
      if (chunk) this.socket.write(chunk);
      req.pipe(this.socket);
    });
    this.socket.on('response', (res)=>this.response(res));
    this.socket.on('error', (err)=>this.error(err));
    this.socket.setTimeout(parseExpires(opt.proxyTimeout), ()=>this.setTimeout());
    // this.socket.end();
  }

  loadSslOptions(opt) {
    if (opt.ssl_ca) {
      try {
        this.options.ca = fs.readFileSync(opt.ssl_ca);
      } catch (e) {}
    }
    if (opt.ssl_key) {
      try {
        this.options.key = fs.readFileSync(opt.ssl_key);
      } catch (e) {}
    }
    if (opt.ssl_cert) {
      try {
        this.options.cert = fs.readFileSync(opt.ssl_cert);
      } catch (e) {}
    }
  }

  response(res) {
    let head = html.tidyHeadTitle(Object.assign({}, res.headers));
    let cachePipe = new cache(this.cachePath);
    delete head['Content-Encoding'];
    this.onCors ? head['Access-Control-Allow-Origin'] = '*' : 0;
    this.cltRes.writeHead(res.statusCode, head);
    cachePipe.writeHead(res.httpVersion, res.statusCode, head);
    switch (res.headers['content-encoding']) {
      case 'gzip':
        res.pipe(zlib.createGunzip()).pipe(cachePipe).pipe(this.cltRes);
      break;
      case 'deflate':
        res.pipe(zlib.createInflate()).pipe(cachePipe).pipe(this.cltRes);
      break;
      default:
        res.pipe(cachePipe).pipe(this.cltRes);
      break;
    }
  }

  error(err) {
    if (this.cachePath) {
      try {
        fs.createReadStream(this.cachePath).pipe(this.cltRes);
        xecho('PROXY ERR: ' + err.errno + ', using old cache', 'warn');
      } catch (e) {
        html.send500(this.cltRes, e);
        xecho('PROXY ERR: ' + e + ', and cache is also invalid', 'error');
      }
    } else {
      html.send500(this.cltRes, err);
      xecho('PROXY ERR: ' + err.errno + ', but you are not allowed to cache this, so...', 'error');
    }
    this.cltRes.end();
  }

  setTimeout() {
    let err = {
      code: 'RESPONSE_TIMEOUT',
      errno: 'RESPONSE_TIMEOUT',
      toString: ()=>'connect timeout!'
    };
    this.error(err);
  }
};

module.exports = Proxy;