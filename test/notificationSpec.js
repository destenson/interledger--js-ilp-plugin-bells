'use strict'

const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.use(chaiAsPromised)
chai.should()

const assert = chai.assert

const mock = require('mock-require')
const nock = require('nock')
const sinon = require('sinon')
const wsHelper = require('./helpers/ws')
const cloneDeep = require('lodash/cloneDeep')

mock('ws', wsHelper.WebSocket)
const PluginBells = require('..')

describe('Notification handling', function () {
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

    this.stubReceive = sinon.stub()
    this.stubFulfillExecutionCondition = sinon.stub()
    this.stubIncomingCancel = sinon.stub()
    this.stubOutgoingCancel = sinon.stub()

    this.plugin.on('incoming_cancel', this.stubIncomingCancel)
    this.plugin.on('outgoing_cancel', this.stubOutgoingCancel)
    this.plugin.on('incoming_prepare', this.stubReceive)
    this.plugin.on('outgoing_fulfill', this.stubFulfillExecutionCondition)

    this.fiveBellsTransferMike = {
      id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
      ledger: 'http://red.example',
      debits: [{
        account: 'http://red.example/accounts/alice',
        amount: '10'
      }],
      credits: [{
        account: 'http://red.example/accounts/mike',
        amount: '10'
      }],
      state: 'rejected'
    }
    this.fiveBellsTransferAlice = {
      id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
      ledger: 'http://red.example',
      debits: [{
        account: 'http://red.example/accounts/mike',
        amount: '10'
      }],
      credits: [{
        account: 'http://red.example/accounts/alice',
        amount: '10'
      }],
      state: 'rejected'
    }

    this.transfer = {
      id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
      direction: 'incoming',
      account: 'example.red.alice',
      amount: '10',
      expiresAt: (new Date((new Date()).getTime() + 1000)).toISOString()
    }
  })

  afterEach(function * () {
    this.wsRedLedger.stop()
  })

  describe('notifications of unrelated transfers', function () {
    it('emits an UnrelatedNotificationError for an unrelated notification', function (done) {
      this.wsRedLedger.on('message', function (message) {
        assert.deepEqual(JSON.parse(message), {
          result: 'ignored',
          ignoreReason: {
            id: 'UnrelatedNotificationError',
            message: 'Notification does not seem related to connector'
          }
        })
        done()
      })
      this.wsRedLedger.send(JSON.stringify({
        resource: {
          id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
          ledger: 'http://red.example',
          debits: [{
            account: 'http://red.example/accounts/alice',
            amount: '10'
          }],
          credits: [{
            account: 'http://red.example/accounts/bob',
            amount: '10'
          }],
          state: 'executed'
        }
      }))
    })
  })

  describe('notification of timeout', function () {
    it('should handle a rejected transfer to mike', function * () {
      this.wsRedLedger.send(JSON.stringify({
        resource: Object.assign(this.fiveBellsTransferAlice, {
          execution_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
        }),
        related_resources: {
          execution_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
      sinon.assert.calledOnce(this.stubOutgoingCancel)
      sinon.assert.notCalled(this.stubFulfillExecutionCondition)
    })

    it('should handle a rejected transfer to alice', function * () {
      this.wsRedLedger.send(JSON.stringify({
        resource: Object.assign(this.fiveBellsTransferMike, {
          execution_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
        }),
        related_resources: {
          execution_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
        }
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
      sinon.assert.calledOnce(this.stubIncomingCancel)
      sinon.assert.notCalled(this.stubFulfillExecutionCondition)
    })
  })

  describe('notifications of incoming transfers', function () {
    beforeEach(function () {
      this.stubPrepare = sinon.stub()
      this.stubExecute = sinon.stub()
      this.stubReject = sinon.stub()
      this.stubFulfillExecutionCondition = sinon.stub()
      this.stubFulfillCancellationCondition = sinon.stub()
      this.plugin.on('incoming_prepare', this.stubPrepare)
      this.plugin.on('incoming_transfer', this.stubExecute)
      this.plugin.on('incoming_reject', this.stubReject)
      this.plugin.on('incoming_fulfill', this.stubFulfillExecutionCondition)
      this.plugin.on('incoming_cancel', this.stubFulfillCancellationCondition)

      this.fiveBellsTransferExecuted = {
        id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        ledger: 'http://red.example',
        debits: [{
          account: 'http://red.example/accounts/alice',
          amount: '10'
        }],
        credits: [{
          account: 'http://red.example/accounts/mike',
          amount: '10'
        }],
        state: 'executed'
      }
      this.transfer = {
        id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        direction: 'incoming',
        account: 'example.red.alice',
        ledger: 'example.red.',
        amount: '10'
      }
    })

    it('should emit "incoming_fulfill" on incoming executed transfers',
      itEmitsFulfillExecutionCondition)
    it('should emit "incoming_cancel" on incoming rejected transfers',
      itEmitsFulfillCancellationCondition)

    it('should emit "incoming_reject" with the rejection_message', function * () {
      this.wsRedLedger.send(JSON.stringify({
        resource: Object.assign(this.fiveBellsTransferExecuted, {
          state: 'rejected',
          credits: [
            Object.assign(this.fiveBellsTransferExecuted.credits[0], {
              rejected: true,
              rejection_message: new Buffer('fail!').toString('base64')
            })
          ]
        })
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubPrepare) sinon.assert.notCalled(this.stubPrepare)
      sinon.assert.notCalled(this.stubFulfillExecutionCondition)
      sinon.assert.notCalled(this.stubFulfillCancellationCondition)
      sinon.assert.calledOnce(this.stubReject)
      sinon.assert.calledWith(this.stubReject, this.transfer, 'fail!')
    })

    it('should pass on incoming prepared transfers', function * () {
      this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
      this.fiveBellsTransferExecuted.state = 'prepared'
      this.wsRedLedger.send(JSON.stringify({
        resource: this.fiveBellsTransferExecuted
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubPrepare)
      sinon.assert.calledWith(this.stubPrepare, Object.assign(this.transfer, {
        expiresAt: this.fiveBellsTransferExecuted.expires_at
      }))
    })

    it('should pass on incoming executed transfers', function * () {
      this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
      this.wsRedLedger.send(JSON.stringify({
        resource: this.fiveBellsTransferExecuted
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubExecute)
      sinon.assert.calledWith(this.stubExecute, Object.assign(this.transfer, {
        expiresAt: this.fiveBellsTransferExecuted.expires_at
      }))
    })

    it('should ignore unrelated credits', function * () {
      this.fiveBellsTransferExecuted.credits.push({
        account: 'http://red.example/accounts/george',
        amount: '10'
      })
      this.wsRedLedger.send(JSON.stringify({
        resource: this.fiveBellsTransferExecuted
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubExecute)
      sinon.assert.calledWith(this.stubExecute, this.transfer)
    })
  })

  describe('notifications of outgoing transfers', function () {
    beforeEach(function () {
      this.stubFulfillExecutionCondition = sinon.stub()
      this.stubFulfillCancellationCondition = sinon.stub()
      this.stubOutgoingPrepare = sinon.stub()
      this.stubOutgoingExecute = sinon.stub()
      this.stubOutgoingReject = sinon.stub()
      this.plugin.on('outgoing_prepare', this.stubOutgoingPrepare)
      this.plugin.on('outgoing_transfer', this.stubOutgoingExecute)
      this.plugin.on('outgoing_fulfill', this.stubFulfillExecutionCondition)
      this.plugin.on('outgoing_cancel', this.stubFulfillCancellationCondition)
      this.plugin.on('outgoing_reject', this.stubOutgoingReject)

      this.fiveBellsTransferExecuted = {
        id: 'http://red.example/transfers/ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        ledger: 'http://red.example',
        debits: [{
          account: 'http://red.example/accounts/mike',
          amount: '10'
        }],
        credits: [{
          account: 'http://red.example/accounts/alice',
          amount: '10'
        }],
        state: 'executed'
      }
      this.transfer = {
        id: 'ac518dfb-b8a6-49ef-b78d-5e26e81d7a45',
        direction: 'outgoing',
        account: 'example.red.alice',
        ledger: 'example.red.',
        amount: '10'
      }
    })

    it('should emit "outgoing_fulfill" on outgoing executed transfers',
      itEmitsFulfillExecutionCondition)
    it('should emit "outgoing_cancel" on outgoing rejected transfers',
      itEmitsFulfillCancellationCondition)

    it('should emit outgoing_cancel with the rejection_message', function * () {
      this.wsRedLedger.send(JSON.stringify({
        resource: Object.assign(this.fiveBellsTransferExecuted, {
          state: 'rejected',
          credits: [
            Object.assign(this.fiveBellsTransferExecuted.credits[0], {
              rejected: true,
              rejection_message: new Buffer('fail!').toString('base64')
            })
          ]
        })
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

      if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
      sinon.assert.notCalled(this.stubFulfillExecutionCondition)
      sinon.assert.notCalled(this.stubFulfillCancellationCondition)
      sinon.assert.calledOnce(this.stubOutgoingReject)
      sinon.assert.calledWith(this.stubOutgoingReject, this.transfer, 'fail!')
    })

    it('be notified of an outgoing prepare', function * () {
      this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
      this.fiveBellsTransferExecuted.state = 'prepared'
      this.wsRedLedger.send(JSON.stringify({
        resource: this.fiveBellsTransferExecuted
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubOutgoingPrepare)
      sinon.assert.calledWith(this.stubOutgoingPrepare, Object.assign(this.transfer, {
        expiresAt: this.fiveBellsTransferExecuted.expires_at
      }))
    })

    it('be notified of an outgoing execute', function * () {
      this.fiveBellsTransferExecuted.expires_at = (new Date()).toISOString()
      this.wsRedLedger.send(JSON.stringify({
        resource: this.fiveBellsTransferExecuted
      }))

      yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))
      sinon.assert.calledOnce(this.stubOutgoingExecute)
      sinon.assert.calledWith(this.stubOutgoingExecute, Object.assign(this.transfer, {
        expiresAt: this.fiveBellsTransferExecuted.expires_at
      }))
    })
  })
})

function * itEmitsFulfillExecutionCondition () {
  this.wsRedLedger.send(JSON.stringify({
    resource: Object.assign(this.fiveBellsTransferExecuted, {
      execution_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
    }),
    related_resources: {
      execution_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
    }
  }))

  yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

  if (this.stubPrepare) sinon.assert.notCalled(this.stubPrepare)
  sinon.assert.calledOnce(this.stubFulfillExecutionCondition)
  sinon.assert.calledWith(this.stubFulfillExecutionCondition,
    Object.assign(this.transfer, {
      executionCondition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
    }), 'cf:0:ZXhlY3V0ZQ')
}

function * itEmitsFulfillCancellationCondition () {
  this.wsRedLedger.send(JSON.stringify({
    resource: Object.assign(this.fiveBellsTransferExecuted, {
      state: 'rejected',
      cancellation_condition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
    }),
    related_resources: {
      cancellation_condition_fulfillment: 'cf:0:ZXhlY3V0ZQ'
    }
  }))

  yield new Promise((resolve) => this.wsRedLedger.on('message', resolve))

  if (this.stubReceive) sinon.assert.notCalled(this.stubReceive)
  sinon.assert.notCalled(this.stubFulfillExecutionCondition)
  sinon.assert.calledOnce(this.stubFulfillCancellationCondition)
  sinon.assert.calledWith(this.stubFulfillCancellationCondition,
    Object.assign(this.transfer, {
      cancellationCondition: 'cc:0:3:vmvf6B7EpFalN6RGDx9F4f4z0wtOIgsIdCmbgv06ceI:7'
    }), 'cf:0:ZXhlY3V0ZQ')
}
