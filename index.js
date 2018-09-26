const events = require('events');
const path = require("path");
const dequeue = require('dequeue');
const aurora = require('aurora.js');
const validUrl = require('valid-url');
require('mp3')
require('flac.js')
//require('alac')
//require('aac')
// require('vorbis.js')
// require('opus.js')

const exec = require("ttbd-exec");
const exec_opt = { hydra_exec_host: "mosquitto" };


function isObject(val) {
  if (val === null) { return false;}
  return ( (typeof val === 'function') || (typeof val === 'object') );
}

class Player {
  constructor(params){
    this._playing = false
    this._playback = null
    this._dequeue = new dequeue()
    this._current = null
    this._exec_opt = exec_opt
    if(params && isObject(params) && params.hasOwnProperty('exec_opt') && isObject(params.exec_opt)){
      this._exec_opt = Object.assign({}, exec_opt, params.exec_opt)
    }

    this._emitter = new events.EventEmitter();
    this._defaultDeviceCache = null
  }

  clear(){
    this._emitter.removeAllListeners("error");
    this._emitter.removeAllListeners("end");
    this._emitter.removeAllListeners("next");
    this._emitter.removeAllListeners("progress");
    this._dequeue.empty()
  }

  on(a, b){
    this._emitter.on(a, b);
  }

  start(music, force){
    if(force === true){
      this.stop()
    }
    this._dequeue.push(music)

    if(this._playing == false || force === true){
      this._next()
    }
  }

  stop(){
    this._playing = false;
    this._dequeue.empty();
    if(this._playback){
      this._playback.stop();
    }

    if(this._current){
      this._emitter.emit('end', this._current)
      this._current = null
    }
    this._playback = null;
  }

  pause(){
    if(this._playing === true && this._playback){
      this._playback.pause();
    }
  }

  resume(){
    if(this._playing === true && this._playback){
      this._playback.play();
    }
  }

  skip(){
    this._end()
  }

  set volume(newVolume){
    let volume = Number(newVolume)
    if((volume === 0 || volume) && !isNaN(volume)){
      if(volume < 0) volume = 0;
      if(volume > 100) volume = 100;
      this._setVolume(volume)
    }
    return this
  }

  volumeUp(){
    this._changeVolume('up')
  }

  volumeDown(){
    this._changeVolume('down')
  }

  _next(){
    if(this._dequeue.length === 0){
      this._playing = false;
      return
    }
    this._current = this._dequeue.shift()
    let currentLength = null
    this._playing = true
    if(validUrl.isUri(this._current)){
      this._playback = aurora.Player.fromURL(this._current)
    } else {
      this._playback = aurora.Player.fromFile(this._current)
    }

    this._playback.on('ready', () => {
      this._emitter.emit('next', this._current)
      this._playback.play()
    })
    this._playback.on('duration', (msecs) => {
      currentLength = this._fancyTimeFormat(Math.ceil(msecs/1000))
    })
    this._playback.on('end', () => {
      this._end()
    })
    this._playback.on('progress', (msecs) => {
      this._emitter.emit('progress', {
        name: this._current,
        current: this._fancyTimeFormat(Math.floor(msecs/1000)),
        end: currentLength
      })
    })
    this._playback.on('error', (err) => {
      this._emitter.emit('error', err)
    })
    this._playback.preload()
  }

  _end(){
    if(this._current){
      this._emitter.emit('end', this._current)
    }
    this._current = null
    if(this._playback){
      this._playback.stop();
    }
    this._playback = null
    if(this._dequeue.length === 0){
      this._playing = false;
    } else {
      this._next()
    }
  }

  _amixer(args, callback) {
    if(typeof callback !== 'function'){
      callback = function(){}
    }
    exec(`amixer ${args.join(' ')}`, this._exec_opt, (err, stdout, stderr) => {
      callback(err || stderr || null, stdout.trim())
    })
  }

  _defaultDevice(callback) {
    if(typeof callback !== 'function'){
      callback = function(){}
    }
    if(this._defaultDeviceCache === null) {
      this._amixer([], (err, data) => {
        if(err) {
          callback(err);
        } else {
          var res = this.REGEX.defaultDevice.exec(data);
          if(res === null) {
            callback(new Error('Alsa Mixer Error: failed to parse output'));
          } else {
            this._defaultDeviceCache = res[1];
            callback(null, this._defaultDeviceCache);
          }
        }
      });
    } else {
      callback(null, this._defaultDeviceCache);
    }
  }

  _getInfo(callback) {
    if(typeof callback !== 'function'){
      callback = function(){}
    }
    this._defaultDevice((err, dev) => {
      if(err) {
        callback(err);
      } else {
        this._amixer(['get', dev], (err2, data) => {
          if(err2) {
            callback(err2);
          } else {
            var res = this.REGEX.info.exec(data);
            if(res === null) {
              callback(new Error('Alsa Mixer Error: failed to parse output'));
            } else {
              callback(null, {
                volume: parseInt(res[1], 10),
                muted: (res[2] == 'off')
              });
            }
          }
        });
      }
    });
  }

  _getVolume(callback) {
    if(typeof callback !== 'function'){
      callback = function(){}
    }
    this._getInfo((err, obj) => {
      if(err) {
        callback(err);
      } else {
        callback(null, obj.volume);
      }
    });
  }

  _setVolume(val, callback) {
    if(typeof callback !== 'function'){
      callback = function(){}
    }
    this._defaultDevice((err, dev) => {
      if(err) {
        callback(err);
      } else {
        this._amixer(['set', dev, val + '%'], (err2) => {
          callback(err2);
        });
      }
    });
  }

  _changeVolume(type, callback){
    if(typeof callback !== 'function'){
      callback = function(){}
    }
    this._getVolume( (err, vol) => {
      if(err) {
        callback(err);
      }
      var volume = vol;
      if(type === 'up'){
        volume = volume + this.INCREMENT_STEP
      } else if(type === 'down'){
        volume = volume - this.INCREMENT_STEP
      }
      if(volume < 0) volume = 0;
      if(volume > 100) volume = 100;
      this._setVolume(volume, (err2) => {
        callback(err2);
      });
    })
  }

  _fancyTimeFormat(sec){
    var hrs = Math.floor(sec / 3600);
    var mins = Math.floor((sec % 3600) / 60);
    var secs = sec % 60;

    var ret = "";
    if (hrs > 0) {
        ret += "" + hrs + ":" + (mins < 10 ? "0" : "");
    }
    ret += "" + mins + ":" + (secs < 10 ? "0" : "");
    ret += "" + secs;
    return ret;
  }

  _isObject(val) {
    if (val === null) { return false;}
    return ( (typeof val === 'function') || (typeof val === 'object') );
  }
}

Player.INCREMENT_STEP = 5;
Player.REGEX = {
  defaultDevice: /Simple mixer control \'([a-z0-9 -]+)\',[0-9]+/i,
  info: /[a-z][a-z ]*\: Playback [0-9-]+ \[([0-9]+)\%\] (?:[[0-9\.-]+dB\] )?\[(on|off)\]/i
}

module.exports = {
  Player: Player
}
