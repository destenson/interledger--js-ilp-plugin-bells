'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const mock = require('mock-require')
const nock = require('nock')
const wsHelper = require('./helpers/ws')
const cloneDeep = require('lodash/cloneDeep')

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('Connection methods', function () {
  beforeEach(function * () {
    this.plugin = new PluginBells({
      prefix: 'example.red.',
      account: 'http://red.example/accounts/mike',
      password: 'mike'
    })

    this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))
  })

  afterEach(function * () {
    assert(nock.isDone(), 'nock should be called')
  })

  describe('connect', function () {
    it('connects', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)

      yield assertResolve(this.plugin.connect(), null)
      assert.isTrue(this.plugin.isConnected())
    })

    it('ignores if called twice', function * () {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })

      const nockInfo = nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)

      yield this.plugin.connect()
      yield this.plugin.connect()
      assert.isTrue(this.plugin.isConnected())
      nockInfo.done()
    })

    it('fails if the response is invalid', function (done) {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, { name: 'mike' })

      this.plugin.connect().should.be
        .rejectedWith('Failed to resolve ledger URI from account URI')
        .notify(() => {
          assert.isFalse(this.plugin.isConnected())
          done()
        })
    })

    it('should set the username based on the account name returned', function * () {
      const accountNock = nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      const infoNock = nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      yield this.plugin.connect()
      assert.equal(this.plugin.credentials.username, 'mike')
      accountNock.done()
      infoNock.done()
    })

    it('should not overwrite the username if one is specified in the options', function * () {
      const accountNock = nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })
      const infoNock = nock('http://red.example')
        .get('/')
        .reply(200, this.infoRedLedger)
      const plugin = new PluginBells({
        prefix: 'foo.',
        account: 'http://red.example/accounts/mike',
        password: 'mike',
        username: 'xavier'
      })
      yield plugin.connect()
      assert.equal(plugin.credentials.username, 'xavier')
      accountNock.done()
      infoNock.done()
    })

    it('doesn\'t retry if account is nonexistant', function (done) {
      nock('http://red.example')
        .get('/accounts/mike')
        .reply(404)

      this.plugin.connect().should.be
        .rejectedWith('Failed to resolve ledger URI from account URI')
        .notify(() => {
          assert.isFalse(this.plugin.isConnected())
          done()
        })
    })

    describe('a connector', function () {
      beforeEach(function () {
        this.plugin = new PluginBells({
          connector: 'http://mark.example',
          prefix: 'example.red.',
          account: 'http://red.example/accounts/mike',
          password: 'mike'
        })
      })

      it('sets the connector field', function * () {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, { ledger: 'http://red.example', name: 'mike' })
          .put('/accounts/mike', { name: 'mike', connector: 'http://mark.example' })
          .reply(200)

        const nockInfo = nock('http://red.example')
          .get('/')
          .reply(200, this.infoRedLedger)

        yield this.plugin.connect()

        nockInfo.done()
      })

      it('throws an ExternalError if unable to set the connector field', function (done) {
        nock('http://red.example')
          .get('/accounts/mike')
          .reply(200, { ledger: 'http://red.example', name: 'mike' })
          .put('/accounts/mike', { name: 'mike', connector: 'http://mark.example' })
          .reply(500)
        this.plugin.connect().should.be
          .rejectedWith('Remote error: status=500')
          .notify(done)
      })
    })
  })

  describe('getAccount (not connected)', function () {
    it('throws if not connected', function (done) {
      this.plugin.getAccount().catch(function (err) {
        assert.equal(err.message, 'Must be connected before getAccount can be called')
        done()
      })
    })
  })

  describe('disconnect', function () {
    beforeEach(function * () {
      this.plugin = new PluginBells({
        prefix: 'example.red.',
        account: 'http://red.example/accounts/mike',
        password: 'mike',
        debugReplyNotifications: true,
        debugAutofund: {
          connector: 'http://mark.example',
          admin: {username: 'adminuser', password: 'adminpass'}
        }
      })

      this.wsRedLedger = new wsHelper.Server('ws://red.example/accounts/mike/transfers')
      this.infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

      const nockAccount = nock('http://red.example')
        .get('/accounts/mike')
        .reply(200, {
          ledger: 'http://red.example',
          name: 'mike'
        })

      const infoRedLedger = cloneDeep(require('./data/infoRedLedger.json'))

      const nockInfo = nock('http://red.example')
        .get('/')
        .reply(200, infoRedLedger)

      yield this.plugin.connect()

      nockAccount.done()
      nockInfo.done()
      assert.isTrue(this.plugin.isConnected())
    })

    afterEach(function * () {
      this.wsRedLedger.stop()
    })

    it('closes the connection', function * () {
      yield assertResolve(this.plugin.disconnect(), null)
      assert.isFalse(this.plugin.isConnected())
      // A second time does nothing.
      yield assertResolve(this.plugin.disconnect(), null)
    })
  })
})

function * assertResolve (promise, expected) {
  assert(promise instanceof Promise)
  assert.deepEqual(yield promise, expected)
}
