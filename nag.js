#!/usr/bin/env node

require('dotenv').config()
const _ = require('lodash')
const expect = require('chai').expect
const jsYAML = require('js-yaml')
const fs = require('fs-extra')
const mongo = require('mongodb').MongoClient
const moment = require('moment')
const handlebars = require('handlebars')
const path = require('path')
const replaceExt = require('replace-ext')
const frontMatter = require('front-matter')
const sift = require('sift')
const promptly = require('promptly')

const htmlMinifier = require('html-minifier')
const html_to_text = require('html-to-text')
const nodemailer = require('nodemailer')

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
let defaults = {
  username: 'challen@illinois.edu',
  cache: '.cache/students.json',
  stale: 'PT30M',
  helpers: 'layouts/helpers',
  partials: 'layouts/partials',
  bcc: [ 'challen@illinois.edu' ]
}
let argv = require('minimist')(process.argv.slice(2))
let config = _.extend(
  defaults,
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

Promise.resolve()
  .then(async () => {
    let configuration = frontMatter((await fs.readFile(argv._[0])).toString())
    log.debug(configuration)

    await loadHandlebars()
    let template = handlebars.compile(configuration.body)

    let students
    try {
      expect(config.reload, 'forced reload').to.not.be.ok
      let saved = JSON.parse(await fs.readFile(config.cache))
      students = saved.students
      if (moment() - moment(saved.saved) > moment.duration(config.stale)) {
        throw new Error('cache is stale')
      }
    } catch (err) {
      log.warn(`Reloading student information: ${ err }`)
      students = await update(config)
    }
    expect(students).to.be.an('object')
    log.debug(`${ _.keys(students).length } active students`)
    if (config.students_only) {
      process.exit(0)
    }

    log.debug(configuration.attributes.query)
    let toNag = sift(configuration.attributes.query, _.values(students))
    log.debug(`${ toNag.length } students to nag`)

    let forTemplate = _.omit(_.cloneDeep(configuration.attributes), ['query', 'subject'])
    forTemplate.not_count = _.keys(students).length - toNag.length
    if (config.count_only) {
      process.exit(0)
    }

    let transporter
    if (!(config.dry_run)) {
      transporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net', port: 587, secure: false,
        auth: { user: config.username, pass: process.env.SENDGRID }
      })
      await transporter.verify()
    }

    if (!config.dry_run && !config.send_one_test) {
      let reset = await promptly.choose(`Do you want to send ${ toNag.length } emails?`,
        ['yes', 'no'])
      if (reset === 'no') {
        log.debug(`Cancelled by user`)
        process.exit(0)
      }
    }

    let client = await mongo.connect(process.env.MONGO)
    let nagger = client.db(config.database).collection('nagger')
    let confirmed = false
    for (student of toNag) {
      let thisTemplate = _.extend(_.cloneDeep(forTemplate), student)
      let originalHTML = template(thisTemplate)
      let html = htmlMinifier.minify(originalHTML, {
        collapseWhitespace: true,
        conservativeCollapse: true,
        removeComments: true
      })
      let text = html_to_text.fromString(html, {
        wordwrap: false,
        hideLinkHrefIfSameAsText: true,
        uppercaseHeadings: false,
        noAnchorUrl: false
      })
      let email = {
        from: '"CSE 125 Reminder Robot" <robot@cs125.cs.illinois.edu>',
        bcc: config.bcc.join(","),
        subject: configuration.attributes.subject,
        html: html,
        text: text
      }
      log.debug(email)
      if (config.dry_run) {
        break
      }
      console.log(originalHTML)
      if (!confirmed) {
        let confirm = await promptly.choose(`Does the email above look OK?`, ['yes', 'no'])
        if (confirm === 'no') {
          log.debug(`Cancelled by user`)
          process.exit(0)
        }
        confirmed = true
      }
      if (!config.send_one_test) {
        email.to = student.email
      }
      await transporter.sendMail(email)
      if (config.send_one_test) {
        break
      }
      await nagger.save({
        email: student.email,
        sent: moment().toDate(),
        subject: configuration.attributes.subject,
        html: html
      })
    }
    client.close()
  }).catch(err => {
    throw (err)
  })

let update = async (config) => {
  let client = await mongo.connect(process.env.MONGO)
  let people = client.db(config.database).collection('people')
  let students = _.keyBy(await people.find({
    student: true, active: true
  }).project({
    email: 1, 'name.full': 1, _id: 0
  }).toArray(), 'email')

  _.each(students, student => {
    student.name = student.name.full
    student.progress = {}
  })
  let MPs = {}
  let progress = client.db(config.database).collection('progress')
  _.each(await progress.find({
    totalScore: { $exists: true }
  }).project({
    name: 1, students: 1, totalScore: 1, received: 1, _id: 0
  }).toArray(), progress => {
    MPs[progress.name] = true
    let student
    try {
      let email = progress.students.people[0]
      student = students[email]
      expect(student).to.be.ok
    } catch (error) {
      return
    }
    if (!(student.progress[progress.name])) {
      student.progress[progress.name] = 0
    }
    if (progress.totalScore > student.progress[progress.name]) {
      student.progress[progress.name] = progress.totalScore
    }
  })
  _.each(students, student => {
    _.each(_.keys(MPs), MP => {
      if (!(student.progress[MP])) {
        student.progress[MP] = false
      }
    })
  })

  _.each(students, student => {
    student.MPGrades = {}
  })
  let MPGrades = client.db(config.database).collection('MPGrades')
  _.each(await MPGrades.find({
    'score.best': true
  }).project({
    received: 1, assignment: 1, email: 1, 'score.adjustedScore': 1, _id: 0
  }).toArray(), grade => {
    let student
    try {
      student = students[grade.email]
      expect(student).to.be.ok
    } catch (error) {
      return
    }
    if (!(student.MPGrades[grade.assignment])) {
      student.MPGrades[grade.assignment] = 0
    }
    if (grade.score.adjustedScore > student.MPGrades[grade.assignment]) {
      student.MPGrades[grade.assignment] = grade.score.adjustedScore
    }
  })
  _.each(students, student => {
    _.each(_.keys(MPs), MP => {
      if (!(student.MPGrades[MP])) {
        student.MPGrades[MP] = false
      }
    })
  })

  let quizzes = {}
  _.each(students, student => {
    student.quizGrades = {}
  })
  let quizGrades = client.db(config.database).collection('quizGrades')
  _.each(await quizGrades.find({
    latest: true
  }).toArray(), grade => {
    quizzes[grade.name] = true
    let student
    try {
      student = students[grade.email]
      expect(student).to.be.ok
    } catch (error) {
      return
    }
    if (!(student.quizGrades[grade.name])) {
      student.quizGrades[grade.name] = 0
    }
    if (grade.score > student.quizGrades[grade.name]) {
      student.quizGrades[grade.name] = grade.score
    }
  })
  _.each(students, student => {
    _.each(_.keys(quizzes), quiz => {
      if (!(student.quizGrades[quiz])) {
        student.quizGrades[quiz] = false
      }
    })
  })

  client.close()

  await fs.writeFile(config.cache, JSON.stringify({
    saved: moment().toDate(),
    students: students
  }, null, 2))

  return students
}

let loadHandlebars = async () => {
  let files = await fs.readdir(config.helpers)
  _.each(files, file => {
    if (!(file.endsWith('.js'))) {
      return
    }
    let helperContents = require(path.resolve(path.join(config.helpers, file)))
    switch (typeof helperContents) {
      case 'function':
        let templateName = helperContents.name || file.split('.').shift()
        handlebars.registerHelper(templateName, helperContents)
        break
      case 'object':
        handlebars.registerHelper(helperContents)
        break
    }
  })
  files = await fs.readdir(config.partials)
  _.each(files, async file => {
    if (!(file.endsWith('.hbs'))) {
      return
    }
    let partial = await fs.readFile(path.resolve(path.join(config.partials, file)))
    handlebars.registerPartial(replaceExt(file, ''), partial.toString())
  })
}
