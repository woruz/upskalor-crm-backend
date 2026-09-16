import assert from 'node:assert/strict'
import test from 'node:test'

import { LEAD_STATUSES, LeadInputError, parseLeadFilters, parseLeadInput } from './leads.js'

const validLead = {
    customerName: '  Priya Sharma  ',
    mobileNumber: '9876543210',
    email: 'PRIYA@example.com',
    monthlyBillAmount: 2500,
    followUpDate: '2026-09-20T10:00:00.000Z'
}

void test('parseLeadInput normalizes a valid lead payload', () => {
    const parsed = parseLeadInput(validLead)

    assert.equal(parsed.customerName, 'Priya Sharma')
    assert.equal(parsed.email, 'priya@example.com')
    assert.equal(parsed.mobileNumber, '9876543210')
    assert.equal(parsed.status, 'NEW')
    assert.ok(parsed.followUpDate instanceof Date)
})

void test('parseLeadInput rejects missing required fields', () => {
    for (const field of ['customerName', 'mobileNumber', 'followUpDate']) {
        const payload = { ...validLead }
        delete payload[field as keyof typeof payload]
        assert.throws(() => parseLeadInput(payload), LeadInputError)
    }
})

void test('parseLeadInput rejects invalid mobile, email, and negative amount', () => {
    assert.throws(() => parseLeadInput({ ...validLead, mobileNumber: '12345' }), /mobileNumber is invalid/)
    assert.throws(() => parseLeadInput({ ...validLead, email: 'invalid-email' }), /email is invalid/)
    assert.throws(() => parseLeadInput({ ...validLead, monthlyBillAmount: -1 }), /monthlyBillAmount is invalid/)
})

void test('parseLeadInput validates statuses and executive UUIDs', () => {
    assert.deepEqual(LEAD_STATUSES, ['NEW', 'CONTACTED', 'FOLLOW_UP', 'INTERESTED', 'NOT_INTERESTED', 'CONVERTED', 'LOST'])
    assert.throws(() => parseLeadInput({ ...validLead, status: 'UNKNOWN' }), /status is invalid/)
    assert.throws(() => parseLeadInput({ ...validLead, assignedExecutive: 'not-a-uuid' }), /assignedExecutive is invalid/)
})

void test('parseLeadFilters supports database-backed list filters and pagination', () => {
    const filters = parseLeadFilters(
        new URL(
            'http://localhost/leads?page=2&limit=10&search=priya&status=CONTACTED&assignedExecutive=123e4567-e89b-12d3-a456-426614174000&followUpDateFrom=2026-09-01&followUpDateTo=2026-09-30&sort=customerName&direction=asc'
        )
    )

    assert.equal(filters.page, 2)
    assert.equal(filters.limit, 10)
    assert.equal(filters.status, 'CONTACTED')
    assert.equal(filters.sort, 'customerName')
    assert.equal(filters.direction, 'asc')
})

void test('parseLeadFilters rejects excessive page sizes and invalid date ranges', () => {
    assert.throws(() => parseLeadFilters(new URL('http://localhost/leads?limit=101')), /limit must be at most/)
    assert.throws(
        () => parseLeadFilters(new URL('http://localhost/leads?followUpDateFrom=2026-10-01&followUpDateTo=2026-09-01')),
        /followUpDateFrom must be before/
    )
})
