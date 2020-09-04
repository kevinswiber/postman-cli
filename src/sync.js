const fs = require('fs')
const { Readable } = require('stream')
const browserify = require('browserify')
const detective = require('detective')
const through = require('through2')
const promisify = require('util').promisify
const config = require('./lib/config')
const file = require('./lib/file')
const recurseCollection = require('./lib/recurse-collection')

// Reference: https://learning.postman.com/docs/writing-scripts/script-references/postman-sandbox-api-reference/
const sandboxBuiltins = [
  'ajv', 'atob', 'btoa', 'chai', 'cheerio', 'crypto-js',
  'csv-parse/lib/sync', 'lodash', 'moment', 'postman-collection',
  'tv4', 'uuid', 'xml2js', 'path', 'assert', 'buffer', 'util',
  'url', 'punycode', 'querystring', 'string-decoder', 'stream',
  'timers', 'events'
]

module.exports = async function sync (command) {
  const collection = await recurseCollection(wrapMapFile(command.debug))

  file.collection.write(collection, command.debug)
}

function wrapMapFile (debug) {
  return async function (req, context, type) {
    return mapFileToItem(req, context, type, debug)
  }
}

async function mapFileToItem (req, context, type, debug) {
  const { POSTMAN_DIR } = config.get()
  const isScript = type === 'prerequest' || type === 'test'
  const fileExtension = isScript ? 'js' : 'json'
  const path = `${POSTMAN_DIR}/${context}/${req.name || ''}/${type}.${fileExtension}`
  const localFileExists = fs.existsSync(path)

  if (localFileExists) {
    if (isScript) {
      const index = req.event.findIndex((el) => el.listen === type)
      req.event[index].script.exec = await maybeBundle(path, debug)
    } else {
      req[type] = readItemFile(path)
    }
  }

  return req
}

async function maybeBundle (path, debug) {
  let source = fs.readFileSync(path)
  const requires = detective(source).filter(r => !sandboxBuiltins.includes(r))

  if (debug) {
  }

  if (requires.length) {
    const stream = Readable.from(source)
    stream.file = path
    return bundle(stream, debug)
  } else {
    if (debug) {
      source += '\n//# sourceURL=' + encodeURI(`file://${process.cwd()}/${path}`)
      source = `eval(${JSON.stringify(source)});`
    }

    return source.toString('utf8')
  }
}

async function bundle (file, debug) {
  const b = browserify()
  b.add(file)
  b.external(sandboxBuiltins)

  if (debug) {
    b.plugin(evalWrap)
  }

  const doBundle = promisify(b.bundle.bind(b))
  const buf = await doBundle()
  const script = buf.toString()

  return script.split('\n')
}

function readItemFile (path) {
  return JSON.parse(fs.readFileSync(path))
}

function evalWrap (b, opts) {
  const addHooks = () => {
    b.pipeline.get('debug').push(through.obj((row, _enc, next) => {
      row.source += '\n//# sourceURL=' + encodeURI(`file://${process.cwd()}/${row.file}`)
      row.source = `eval(${JSON.stringify(row.source)});`
      next(null, row)
    }))
  }

  b.on('reset', addHooks)
  addHooks()
}
