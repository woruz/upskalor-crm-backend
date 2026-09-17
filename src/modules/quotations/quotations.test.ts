import assert from 'node:assert/strict'
import test from 'node:test'

import {
    calculateFinancialSummary,
    parseQuotationFilters,
    parseQuotationInput,
    parseQuotationItem,
    QUOTATION_STATUSES,
    QuotationInputError
} from './quotations.js'

const validQuotation = {
    leadId: '123e4567-e89b-12d3-a456-426614174000',
    quoteNumber: 'QT-2026-0005',
    systemSizeKw: 5.5,
    validityDate: '2026-10-02T00:00:00.000Z',
    paymentTermsTemplate: 'Custom Terms',
    advancePercentage: 30,
    deliveryPercentage: 50,
    commissioningPercentage: 20,
    stateSubsidyCapOverride: 15000,
    leadState: 'maharashtra',
    centralSubsidy: 78000,
    stateSubsidy: 0,
    status: 'DRAFT',
    items: [
        {
            name: 'Solar Panel 540W',
            brand: 'Tata Power Solar',
            quantity: 10,
            rate: 18000,
            gstRate: 12
        },
        {
            name: 'Solar Inverter 5kW',
            brand: 'Growatt',
            quantity: 1,
            rate: 45000,
            gstRate: 18
        }
    ]
}

void test('parseQuotationItem parses and computes line item values correctly', () => {
    const item = parseQuotationItem({
        name: '  Solar Panel 540W  ',
        brand: 'Tata',
        quantity: 2,
        rate: 15000,
        gstRate: 12
    })

    assert.equal(item.name, 'Solar Panel 540W')
    assert.equal(item.brand, 'Tata')
    assert.equal(item.quantity, 2)
    assert.equal(item.rate, 15000)
    assert.equal(item.gstRate, 12)
    // 2 * 15000 = 30000; gst = 3600; total = 33600
    assert.equal(item.total, 33600)
})

void test('parseQuotationItem rejects invalid inputs', () => {
    assert.throws(() => parseQuotationItem({ name: '', rate: 1000 }), QuotationInputError)
    assert.throws(() => parseQuotationItem({ name: 'Panel', rate: -50 }), QuotationInputError)
    assert.throws(() => parseQuotationItem({ name: 'Panel', rate: 1000, quantity: 0 }), QuotationInputError)
    assert.throws(() => parseQuotationItem({ name: 'Panel', rate: 1000, gstRate: 150 }), QuotationInputError)
})

void test('calculateFinancialSummary calculates subtotal, GST, grand total and net cost', () => {
    const items = [
        { name: 'Item 1', quantity: 2, rate: 10000, gstRate: 10, total: 22000, sortOrder: 0 },
        { name: 'Item 2', quantity: 1, rate: 5000, gstRate: 18, total: 5900, sortOrder: 1 }
    ]
    // Subtotal: (2*10000) + (1*5000) = 25000
    // GST: (20000*0.1) + (5000*0.18) = 2000 + 900 = 2900
    // Grand Total: 27900
    // Central Subsidy: 10000, State: 2000 => Net Customer Cost: 27900 - 12000 = 15900
    const summary = calculateFinancialSummary(items, 10000, 2000)
    assert.equal(summary.subtotal, 25000)
    assert.equal(summary.totalGst, 2900)
    assert.equal(summary.grandTotal, 27900)
    assert.equal(summary.centralSubsidy, 10000)
    assert.equal(summary.stateSubsidy, 2000)
    assert.equal(summary.netCustomerCost, 15900)
})

void test('parseQuotationInput normalizes valid payload and calculates financial summary', () => {
    const parsed = parseQuotationInput(validQuotation)

    assert.equal(parsed.quoteNumber, 'QT-2026-0005')
    assert.equal(parsed.systemSizeKw, 5.5)
    assert.equal(parsed.paymentTermsTemplate, 'Custom Terms')
    assert.equal(parsed.advancePercentage, 30)
    assert.equal(parsed.deliveryPercentage, 50)
    assert.equal(parsed.commissioningPercentage, 20)
    assert.equal(parsed.leadState, 'maharashtra')
    assert.equal(parsed.status, 'DRAFT')
    assert.equal(parsed.items?.length, 2)

    // Items:
    // Item 1: 10 * 18000 = 180,000; gst @ 12% = 21,600
    // Item 2: 1 * 45000 = 45,000; gst @ 18% = 8,100
    // Subtotal = 225,000
    // GST = 29,700
    // Grand Total = 254,700
    // Net Customer Cost = 254,700 - 78,000 = 176,700
    assert.equal(parsed.subtotal, 225000)
    assert.equal(parsed.totalGst, 29700)
    assert.equal(parsed.grandTotal, 254700)
    assert.equal(parsed.netCustomerCost, 176700)
})

void test('parseQuotationInput rejects missing or invalid required fields', () => {
    assert.throws(() => parseQuotationInput({ ...validQuotation, systemSizeKw: 0 }), QuotationInputError)
    assert.throws(() => parseQuotationInput({ ...validQuotation, systemSizeKw: -5 }), QuotationInputError)
    assert.throws(() => parseQuotationInput({ ...validQuotation, validityDate: 'not-a-date' }), QuotationInputError)
    assert.throws(() => parseQuotationInput({ ...validQuotation, advancePercentage: 150 }), QuotationInputError)
    assert.throws(() => parseQuotationInput({ ...validQuotation, leadId: 'invalid-uuid' }), QuotationInputError)
})

void test('parseQuotationFilters parses query parameters correctly', () => {
    const filters = parseQuotationFilters(
        new URL(
            'http://localhost/quotations?page=3&limit=25&search=QT-2026&status=ACCEPTED&leadId=123e4567-e89b-12d3-a456-426614174000&sort=grandTotal&direction=asc'
        )
    )

    assert.equal(filters.page, 3)
    assert.equal(filters.limit, 25)
    assert.equal(filters.search, 'QT-2026')
    assert.equal(filters.status, 'ACCEPTED')
    assert.equal(filters.leadId, '123e4567-e89b-12d3-a456-426614174000')
    assert.equal(filters.sort, 'grandTotal')
    assert.equal(filters.direction, 'asc')
})

void test('parseQuotationFilters rejects out-of-bound limit or invalid sort', () => {
    assert.throws(() => parseQuotationFilters(new URL('http://localhost/quotations?limit=200')), QuotationInputError)
    assert.throws(() => parseQuotationFilters(new URL('http://localhost/quotations?sort=unknown')), QuotationInputError)
    assert.throws(() => parseQuotationFilters(new URL('http://localhost/quotations?direction=sideways')), QuotationInputError)
})

void test('QUOTATION_STATUSES catalog contains expected statuses', () => {
    assert.deepEqual(QUOTATION_STATUSES, ['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'])
})
