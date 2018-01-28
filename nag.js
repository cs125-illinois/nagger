#!/usr/bin/env node

require('dotenv').config()
const _ = require('lodash')
const expect = require('chai').expect
const jsYAML = require('js-yaml')
const fs = require('fs')

const bunyan = require('bunyan')
const log = bunyan.createLogger({
  name: 'nagger',
  streams: [
    {
      type: 'rotating-file',
      path: 'logs/nagger.log',
      period: '1d',
      count: 365,
      level: 'debug'
    }
  ]
})
let argv = require('minimist')(process.argv.slice(2))
let config = _.extend(
  jsYAML.safeLoad(fs.readFileSync('config.yaml', 'utf8')),
  argv
)
let PrettyStream = require('bunyan-prettystream')
let prettyStream = new PrettyStream()
prettyStream.pipe(process.stdout)
if (config.debug) {
  log.addStream({
    type: 'raw',
    stream: prettyStream,
    level: "debug"
  })
} else {
  log.addStream({
    type: 'raw',
    stream: prettyStream,
    level: "warn"
  })
}
log.debug(_.omit(config))
