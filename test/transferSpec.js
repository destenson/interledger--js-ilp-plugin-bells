'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const mock = require('mock-require')
const nock = require('nock')
const wsHelper = require('./helpers/ws')
const errors = require('../src/errors')
const cloneDeep = require('lodash/cloneDeep')

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('Transfer methods', function () {
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

    this.wsRedLedger = new wsHelper.Server('ws://red.example/accounts/mike/transfers')

    yield this.plugin.connect()

    nockAccount.done()
    nockInfo.done()
  })

  afterEach(function * () {
    this.wsRedLedger.stop()
  })

  describe('send', function () {
    it('submits a transfer', function * () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', {
          id: 'http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          ledger: 'http://red.example',
          debits: [{
            account: 'http://red.example/accounts/mike',
            amount: '123',
            authorized: true,
            memo: {source: 'something'}
          }],
          credits: [{
            account: 'http://red.example/accounts/alice',
            amount: '123',
            memo: {foo: 'bar'}
          }]
        })
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(200)
      yield assertResolve(this.plugin.send({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123',
        noteToSelf: {source: 'something'},
        data: {foo: 'bar'}
      }), null)
    })

    it('throws InvalidFieldsError for missing account', function (done) {
      this.plugin.send({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        amount: '1'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid account').notify(done)
    })

    it('throws InvalidFieldsError for missing amount', function (done) {
      this.plugin.send({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid amount').notify(done)
    })

    it('throws InvalidFieldsError for negative amount', function (done) {
      this.plugin.send({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '-1'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'invalid amount').notify(done)
    })

    it('rejects a transfer when the destination does not begin with the correct prefix', function * () {
      yield assert.isRejected(this.plugin.send({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'red.alice',
        amount: '123',
        noteToSelf: {source: 'something'},
        data: {foo: 'bar'}
      }), /^Error: Destination address "red.alice" must start with ledger prefix "example.red."$/)
    })

    it('throws an InvalidFieldsError on InvalidBodyError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(400, {id: 'InvalidBodyError', message: 'fail'})

      this.plugin.send({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123'
      }).should.be.rejectedWith(errors.InvalidFieldsError, 'fail').notify(done)
    })

    it('throws a DuplicateIdError on InvalidModificationError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(400, {id: 'InvalidModificationError', message: 'fail'})

      this.plugin.send({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123'
      }).should.be.rejectedWith(errors.DuplicateIdError, 'fail').notify(done)
    })

    it('throws an NotAcceptedError on 400', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', {
          id: 'http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          ledger: 'http://red.example',
          debits: [{
            account: 'http://red.example/accounts/mike',
            amount: '123',
            authorized: true
          }],
          credits: [{
            account: 'http://red.example/accounts/alice',
            amount: '123'
          }]
        })
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(400, {id: 'SomeError', message: 'fail'})

      this.plugin.send({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123'
      }).should.be.rejectedWith(errors.NotAcceptedError, 'fail').notify(done)
    })

    it('sets up case notifications when "cases" is provided', function * () {
      nock('http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086')
        .post('/targets', ['http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment'])
        .reply(200)
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c', {
          id: 'http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
          ledger: 'http://red.example',
          debits: [{
            account: 'http://red.example/accounts/mike',
            amount: '123',
            authorized: true
          }],
          credits: [{
            account: 'http://red.example/accounts/alice',
            amount: '123'
          }],
          additional_info: {cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']}
        })
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(200)

      yield this.plugin.send({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123',
        cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']
      })
    })

    it('handles unexpected status on cases notification', function (done) {
      nock('http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086')
        .post('/targets', ['http://red.example/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment'])
        .reply(400)

      this.plugin.send({
        id: '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        account: 'example.red.alice',
        amount: '123',
        cases: ['http://notary.example/cases/2cd5bcdb-46c9-4243-ac3f-79046a87a086']
      }).should.be.rejectedWith('Unexpected status code: 400').notify(done)
    })
  })

  describe('fulfillCondition', function () {
    it('throws InvalidFieldsError on InvalidBodyError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(422, {id: 'InvalidBodyError', message: 'fail'})
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
        .should.be.rejectedWith(errors.InvalidFieldsError, 'fail')
        .notify(done)
    })

    it('throws NotAcceptedError on UnmetConditionError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(422, {id: 'UnmetConditionError', message: 'fail'})
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
        .should.be.rejectedWith(errors.NotAcceptedError, 'fail')
        .notify(done)
    })

    it('throws TransferNotConditionalError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(422, {id: 'TransferNotConditionalError', message: 'fail'})
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
        .should.be.rejectedWith(errors.TransferNotConditionalError, 'fail')
        .notify(done)
    })

    it('throws TransferNotFoundError on NotFoundError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(404, {id: 'NotFoundError', message: 'fail'})
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
        .should.be.rejectedWith(errors.TransferNotFoundError, 'fail')
        .notify(done)
    })

    it('throws AlreadyRolledBackError when fulfilling a rejected transfer', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:0')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(404, {
          id: 'InvalidModificationError',
          message: 'Transfers in state rejected may not be executed'
        })
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:0')
        .should.be.rejectedWith(errors.AlreadyRolledBackError, 'Transfers in state rejected may not be executed')
        .notify(done)
    })

    it('puts the fulfillment', function * () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:ZXhlY3V0ZQ')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(201)
      yield assertResolve(this.plugin.fulfillCondition(
        '6851929f-5a91-4d02-b9f4-4ae6b7f1768c',
        'cf:0:ZXhlY3V0ZQ'), null)
    })

    it('throws an ExternalError on 500', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment', 'cf:0:ZXhlY3V0ZQ')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(500)
      this.plugin.fulfillCondition('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'cf:0:ZXhlY3V0ZQ')
        .should.be.rejectedWith('Failed to submit fulfillment for' +
          ' transfer: 6851929f-5a91-4d02-b9f4-4ae6b7f1768c' +
          ' Error: undefined')
        .notify(done)
    })
  })

  describe('getFulfillment', function () {
    it('returns the fulfillment', function * () {
      nock('http://red.example')
        .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(200, 'cf:0:ZXhlY3V0ZQ')
      yield assertResolve(
        this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c'),
        'cf:0:ZXhlY3V0ZQ')
    })

    it('throws TransferNotFoundError', function * () {
      nock('http://red.example')
        .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(404, {
          id: 'TransferNotFoundError',
          message: 'This transfer does not exist'
        })
      try {
        yield this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
      } catch (err) {
        assert.equal(err.name, 'TransferNotFoundError')
        return
      }
      assert(false)
    })

    it('throws MissingFulfillmentError', function * () {
      nock('http://red.example')
        .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(404, {
          id: 'MissingFulfillmentError',
          message: 'This transfer has no fulfillment'
        })
      try {
        yield this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
      } catch (err) {
        assert.equal(err.name, 'MissingFulfillmentError')
        return
      }
      assert(false)
    })

    it('throws an ExternalError on 500', function * () {
      nock('http://red.example')
        .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .basicAuth({user: 'mike', pass: 'mike'})
        .reply(500)
      try {
        yield this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
      } catch (err) {
        assert.equal(err.name, 'ExternalError')
        assert.equal(err.message, 'Remote error: status=500')
        return
      }
      assert(false)
    })

    it('throws an ExternalError on error', function * () {
      nock('http://red.example')
        .get('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/fulfillment')
        .basicAuth({user: 'mike', pass: 'mike'})
        .replyWithError('broken')
      try {
        yield this.plugin.getFulfillment('6851929f-5a91-4d02-b9f4-4ae6b7f1768c')
      } catch (err) {
        assert.equal(err.name, 'ExternalError')
        assert.equal(err.message, 'Remote error: message=broken')
        return
      }
      assert(false)
    })
  })

  describe('rejectIncomingTransfer', function () {
    it('returns null on success', function * () {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
        .reply(200, {whatever: true})
      yield assertResolve(
        this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!'),
        null)
    })

    it('throws NotAcceptedError on UnauthorizedError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
        .reply(422, {id: 'UnauthorizedError', message: 'error'})
      this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!')
        .should.be.rejectedWith(errors.NotAcceptedError, 'error')
        .notify(done)
    })

    it('throws TransferNotFoundError on NotFoundError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
        .reply(404, {id: 'NotFoundError', message: 'error'})
      this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!')
        .should.be.rejectedWith(errors.TransferNotFoundError, 'error')
        .notify(done)
    })

    it('throws AlreadyFulfilledError on InvalidModificationError', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
        .reply(404, {id: 'InvalidModificationError', message: 'error'})
      this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!')
        .should.be.rejectedWith(errors.AlreadyFulfilledError, 'error')
        .notify(done)
    })

    it('throws ExternalError on 500', function (done) {
      nock('http://red.example')
        .put('/transfers/6851929f-5a91-4d02-b9f4-4ae6b7f1768c/rejection', 'fail!')
        .reply(500)
      this.plugin.rejectIncomingTransfer('6851929f-5a91-4d02-b9f4-4ae6b7f1768c', 'fail!')
        .should.be.rejectedWith('Remote error: status=500')
        .notify(done)
    })
  })
})

function * assertResolve (promise, expected) {
  assert(promise instanceof Promise)
  assert.deepEqual(yield promise, expected)
}
