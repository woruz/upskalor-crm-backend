import assert from 'node:assert/strict'
import test from 'node:test'
import {
    INVOICE_STATUSES,
    MILESTONE_STATUSES,
    PAYMENT_MODES,
    PAYMENT_RECEIPT_STATUSES,
    PROJECT_STATUSES,
    PaymentConflictError,
    PaymentForbiddenError,
    PaymentInputError,
    PaymentNotFoundError,
    PaymentUnprocessableError
} from './types.js'
import { roundToTwo } from './invoices.js'

void test('Payments catalog constants contain expected values', () => {
    assert.deepEqual(PAYMENT_MODES, ['UPI', 'Net Banking', 'Cheque', 'Cash', 'Credit/Debit Card'])
    assert.deepEqual(PAYMENT_RECEIPT_STATUSES, ['Successful', 'Pending', 'Failed'])
    assert.deepEqual(MILESTONE_STATUSES, ['Pending', 'Partially Received', 'Received', 'Overdue'])
    assert.deepEqual(INVOICE_STATUSES, ['Paid', 'Unpaid', 'Overdue', 'Cancelled'])
    assert.deepEqual(PROJECT_STATUSES, ['ACTIVE', 'COMPLETED', 'CANCELLED', 'ON_HOLD'])
})

void test('Error classes instantiate with correct names and fields', () => {
    const inputErr = new PaymentInputError('Validation failed', [{ field: 'amount', message: 'Amount > 0' }])
    assert.equal(inputErr.name, 'PaymentInputError')
    assert.equal(inputErr.message, 'Validation failed')
    assert.equal(inputErr.details?.length, 1)

    const notFoundErr = new PaymentNotFoundError('Not found')
    assert.equal(notFoundErr.name, 'PaymentNotFoundError')

    const conflictErr = new PaymentConflictError('Conflict')
    assert.equal(conflictErr.name, 'PaymentConflictError')

    const forbiddenErr = new PaymentForbiddenError('Forbidden')
    assert.equal(forbiddenErr.name, 'PaymentForbiddenError')

    const unprocErr = new PaymentUnprocessableError('Unprocessable')
    assert.equal(unprocErr.name, 'PaymentUnprocessableError')
})

void test('roundToTwo properly rounds floats', () => {
    assert.equal(roundToTwo(100.456), 100.46)
    assert.equal(roundToTwo(100.454), 100.45)
    assert.equal(roundToTwo(0), 0)
    assert.equal(roundToTwo(56330 / 1.18), 47737.29)
})

void test('Milestone splits sum to net customer cost', () => {
    const netCustomerCost = 221100
    const advancePct = 30
    const deliveryPct = 50
    const commissioningPct = 20

    const advanceAmount = roundToTwo((netCustomerCost * advancePct) / 100)
    const deliveryAmount = roundToTwo((netCustomerCost * deliveryPct) / 100)
    const commissioningAmount = roundToTwo((netCustomerCost * commissioningPct) / 100)

    assert.equal(advanceAmount, 66330)
    assert.equal(deliveryAmount, 110550)
    assert.equal(commissioningAmount, 44220)
    assert.equal(advanceAmount + deliveryAmount + commissioningAmount, netCustomerCost)
})

void test('Invoice GST computation from net amount is accurate', () => {
    const netAmount = 56330
    const grossAmount = roundToTwo(netAmount / 1.18)
    const gstAmount = roundToTwo(netAmount - grossAmount)

    assert.equal(grossAmount, 47737.29)
    assert.equal(gstAmount, 8592.71)
    assert.equal(roundToTwo(grossAmount + gstAmount), netAmount)
})

void test('Invoice manual creation GST computation is accurate', () => {
    const grossAmount = 50000
    const gstPercentage = 18
    const gstAmount = roundToTwo((grossAmount * gstPercentage) / 100)
    const netAmount = roundToTwo(grossAmount + gstAmount)

    assert.equal(gstAmount, 9000)
    assert.equal(netAmount, 59000)
})

void test('Overpayment detection calculation', () => {
    const amountDue = 110550
    const paidAmount = 100000
    const balance = roundToTwo(amountDue - paidAmount)
    assert.equal(balance, 10550)

    const paymentAmount = 10551
    assert.equal(paymentAmount > balance, true)
})
