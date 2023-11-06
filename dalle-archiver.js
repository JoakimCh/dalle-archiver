#!/usr/bin/env node
import * as fs from 'node:fs'
import * as fsAsync from 'node:fs/promises'
import {ChromeDevToolsProtocol, initChrome} from 'jlc-cdp'
import {EventStreamParser} from 'tiny-event-stream-parser'
import * as n_path from 'node:path'
// import {version} from './package.json' assert {type: 'json'}
import {createRequire} from 'module'
const require = createRequire(import.meta.url)
const {version} = require('./package.json')

const log = console.log
const imageMetadata = new Map()
const waitingForMeta = new Map()
const downloadedImages = new Set()
let cfg, cdp

log('Using dalle-archiver version:', version)

{ // check CLI arguments
  if (process.argv.length > 2) {
    process.argv.slice(2)
    for (let i=2; i<process.argv.length; i++) {
      const cmd = process.argv[i]
      switch (cmd) {
        case '-v': case '-V': case '--version':
        process.exit()
        case '-h': case '--help': 
          log(`Usage: [--config=location] \nSee https://github.com/JoakimCh/dalle-archiver for more help.`)
        process.exit()
        default: {
          if (cmd.startsWith('--config=')) {
            const configPath = cmd.split('=')[1]
            cfg = loadConfig(configPath)
          } else {
            log(`Invalid CLI command: ${cmd}`)
            process.exit(1)
          }
        }
      }
    }
  }
  if (!cfg) cfg = loadConfig() // from CWD
  log('Using archive directory:', cfg.archivePath)
}

try {
  detectAlreadyDownloaded() // by checking the DB records
} catch {}
log(`Images previously archived: ${downloadedImages.size}.`)

await startIntercept()

//#region The functions...

async function startIntercept() {
  log('Connecting to the Chrome DevTools Protocol... ')

  const {info} = await initChrome(cfg)
  const {webSocketDebuggerUrl} = info
  const sessions = new Map()

  cdp = new ChromeDevToolsProtocol({webSocketDebuggerUrl, debug: false})

  cdp.on('close', () => log(`The CDP WebSocket connection was closed. Please reconnect by running this program again (if you're not finished).`))

  cdp.on('Target.targetCreated',     monitorTargetOrNot)
  cdp.on('Target.targetInfoChanged', monitorTargetOrNot)

  async function monitorTargetOrNot({targetInfo: {targetId, url, type}}) {
    if (type == 'page' && url.startsWith('https://chat.openai.com')) {
      if (!sessions.has(targetId)) {
        const session = cdp.newSession({targetId})
        sessions.set(targetId, session)
        session.once('detached', () => {
          sessions.delete(targetId)
        })
        await session.ready // any errors will throw here
        await session.send('Fetch.enable', {
          patterns: [
            {urlPattern: '*file-*.webp*', requestStage: 'Response'},
            {urlPattern: '*backend-api/conversation*', requestStage: 'Response'},
          ]
        })
      }
    } else {
      if (sessions.has(targetId)) {
        log('stopped monitoring:', targetId, url)
        sessions.get(targetId).detach()
        sessions.delete(targetId)
      }
    }
  }

  cdp.on('Network.eventSourceMessageReceived', ({eventName, data}) => {
    log(eventName, data)
  })

  cdp.on('Fetch.requestPaused', async ({requestId, request, responseStatusCode}, sessionId) => {
    let taken
    if (responseStatusCode != 200) {
      log('bad response code:', responseStatusCode, request.url)
    } else {
      try {
        if (request.url.includes('backend-api/conversation')) { // conversation with image details
          taken = interceptConversation({requestId, request, sessionId, responseStatusCode})
        } else { // image download
          const url = new URL(request.url)
          interceptImage({requestId, url, sessionId})
        }
      } catch (error) {
        log(error)
      }
    }
    if (!taken) {
      cdp.send('Fetch.continueRequest', {requestId}, sessionId)
    }
  })

  await cdp.ready
  log('Connection successful!')

  await cdp.send('Target.setDiscoverTargets', {
    discover: true, // turn on
    filter: [{type: 'page'}]
  })
}

function pickPathThatExists(choices) {
  for (const path of choices) {
    if (process.platform == 'win32') {
      // thanks to: https://stackoverflow.com/a/33017068/4216153
      path = path.replace(/%([^%]+)%/g, (_, key) => process.env[key])
    }
    if (fs.existsSync(path)) {
      return path
    }
  }
}

function loadConfig(cfgPath = 'config.json') {
  let cfg
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    if (!(typeof cfg.cdpPort == 'number')) throw Error('Missing cdpPort in config.json.')
    if (!(typeof cfg.chromiumPath == 'string')) throw Error('Missing chromiumPath in config.json.')
    if (!(typeof cfg.archivePath == 'string')) throw Error('Missing archivePath in config.json.')
    if (cfg.archivePath.endsWith('/') || cfg.archivePath.endsWith('\\')) {
      cfg.archivePath = cfg.archivePath.slice(0, -1)
    }
    if (!n_path.isAbsolute(cfg.archivePath)) throw Error('The archivePath must be absolute, not this relative path: '+cfg.archivePath)
    cfg.archivePath = cfg.archivePath.replaceAll('\\', '/') // (Windows is FINE with /, we can even mix them)
  } catch (error) {
    log('No valid config.json found, creating one with default values. Please check it before running me again! The error message was:', error.message)
    try {
      cfg = { // some sane defaults
        cdpPort: randomInt(10000, 65534), // some security is provided by not using the default port
        chromiumPath: (()=>{
          switch (process.platform) {
            default:
              return 'google-chrome'
            case 'win32':
              return pickPathThatExists([
                '%ProgramFiles%/Google/Chrome/Application/chrome.exe',
                '%ProgramFiles(x86)%/Google/Chrome/Application/chrome.exe',
                '%LocalAppData%/Google/Chrome/Application/chrome.exe'
              ]) || 'c:/path/to/chromium-compatible-browser.exe'
            case 'darwin':
              return pickPathThatExists(['~/Library/Application Support/Google/Chrome']) || '/path/to/chromium-compatible-browser'
          }
        })(),
        archivePath: process.platform == 'win32' ? process.cwd().replaceAll('\\', '/') : process.cwd()
      }
      ensureDirectory(cfgPath)
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
    } catch (error) {
      log('Failed creating it, error:', error)
    }
    process.exit()
  }
  return cfg
}

function dateDir(unixtime) {
  const date = new Date(unixtime * 1000)
  return `${date.getFullYear()}/${date.getMonth()+1}/${date.getDate()}`
}

function saveRecord(meta) {
  const path = `${cfg.archivePath}/database/${dateDir(meta.date)}/${meta.gen_id}-${meta.fileId}.json`
  ensureDirectory(path)
  return fsAsync.writeFile(path, JSON.stringify(meta, null, 2))
}

function detectAlreadyDownloaded() {
  const dirsToScan = [`${cfg.archivePath}/database`]
  let path
  while (path = dirsToScan.pop()) {
    for (const entry of fs.readdirSync(path, {withFileTypes: true})) {
      if (entry.isDirectory()) {
        dirsToScan.push(path+'/'+entry.name)
        continue
      }
      if (entry.isFile && entry.name.endsWith('.json')) {
        const [gen_id, fileId] = entry.name.slice(0,-5).split('-')
        downloadedImages.add(fileId)
      }
    }
  }
}

function ensureDirectory(filePath) {
  const dirPath = n_path.dirname(filePath)
  if (!(fs.existsSync(dirPath) && fs.lstatSync(dirPath).isDirectory())) {
    fs.mkdirSync(dirPath, {recursive: true})
  }
}

function archiveImage(meta, imgData) {
  log('archiving:', meta.gen_id)
  const path = `${cfg.archivePath}/images/${dateDir(meta.date)}/${getImgFilename(meta)}`
  ensureDirectory(path)
  fsAsync.writeFile(path, imgData).then(() => {
    saveRecord(meta)
  })
}

function interceptImage({requestId, url, sessionId}) {
  const fileId = url.pathname.slice(6) // /file-
  const guid = url.searchParams.get('rscd').split('filename=')[1]
  if (typeof guid == 'string' && guid.endsWith('.webp')) {
    if (!downloadedImages.has(fileId)) {
      downloadedImages.add(fileId)
      cdp.send('Fetch.getResponseBody', {requestId}, sessionId)
      .then(({body, base64Encoded}) => {
        if (!base64Encoded) return log(fileId+': Not base64 encoded!')
        const imgData = Buffer.from(body, 'base64')
        const meta = imageMetadata.get(fileId)
        if (meta) {
          archiveImage(meta, imgData)
        } else {
          log('fileId awaiting meta:', fileId)
          waitingForMeta.set(fileId, imgData)
        }
      })
    }
  } else {
    throw Error(fileId+': Invalid img GUID?: '+guid)
  }
}

function getImgFilename(meta) {
  const maxLength = 180
  let prompt = meta.prompt
    .replaceAll('. ','_')
    .replaceAll(', ','_')
    .replaceAll('.','_')
    .replaceAll(',','_')
    .replaceAll(' ','-')
    .replace(/[^a-z-_0-9]/gi, '')
  if (prompt.endsWith('_') || prompt.endsWith('-')) {
    prompt = prompt.slice(0, -1)
  }
  if (prompt.length > maxLength) {
    prompt = prompt.slice(0, maxLength) + '…'
  }
  return `${meta.date}-${meta.gen_id}-${prompt}.webp`
}

function interceptConversation({requestId, request, sessionId, responseStatusCode, responseHeaders}) {
  const session = cdp.getSession(sessionId)
  const headers = new Headers(request.headers)
  if (headers.get('accept') == 'text/event-stream') {
    // For content type "text/event-stream" not used with EventSource (e.g. by using fetch instead) Network.eventSourceMessageReceived events are not emitted. Hence we need to intercept the response and parse it ourself. This is far from ideal since we can't stream the response back to the browser, meaning we have to wait for the stream to end before we can answer back everything at once (meaning the events will not be received in real time by the browser).
    session.send('Fetch.getResponseBody', {requestId})
    .then(({body, base64Encoded}) => {
      if (base64Encoded) {
        body = Buffer.from(body, 'base64').toString()
      }
      const eventStreamParser = new EventStreamParser()
      eventStreamParser.on('event', imageMetaFromConversationEvent)
      eventStreamParser.chunk(body)
    })
  } else {
    session.send('Fetch.getResponseBody', {requestId})
    .then(({body, base64Encoded}) => {
      if (base64Encoded) {
        body = Buffer.from(body, 'base64').toString()
      }
      imageMetaFromConversation(JSON.parse(body))
    })
  }
}

function imageMetaFromConversationEvent({type, data}) {
  if (data == '[DONE]') return
  if (type != 'message') return
  try {
    data = JSON.parse(data)
  } catch (error) {
    log('can not parse:', data)
  }
  if (data.message) {
    imageMetaFromMessage(data.message)
  }
}

function imageMetaFromConversation(conversation) {
  if (!conversation.mapping) return
  for (const [key, value] of Object.entries(conversation.mapping)) {
    if (value.message) {
      imageMetaFromMessage(value.message)
    }
  }
}

function imageMetaFromMessage(message) {
  const {
    create_time, 
    content: {
      content_type, parts
    }
  } = message
  if (content_type == 'multimodal_text') {
    for (const part of parts) {
      if (part.content_type == 'image_asset_pointer') {
        const {width, height, asset_pointer, metadata} = part
        const {prompt, gen_id, seed} = metadata.dalle
        const fileId = asset_pointer.slice(asset_pointer.lastIndexOf('-')+1)
        const meta = {
          date: Math.trunc(create_time || Date.now() / 1000),
          fileId, width, height, gen_id, seed, prompt
        }
        imageMetadata.set(fileId, meta)
        const imgData = waitingForMeta.get(fileId)
        if (imgData) {
          waitingForMeta.delete(fileId)
          log('fileId received meta:', fileId)
          archiveImage(meta, imgData)
        }
      }
    }
  }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1) + min)
}

//#endregion
