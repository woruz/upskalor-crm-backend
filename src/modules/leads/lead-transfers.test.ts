import assert from 'node:assert/strict'
import test from 'node:test'

import { parseTransferFormat, parseUploadRequest, TransferInputError } from './lead-transfers.js'

const maxFileSize = 1024 * 1024

void test('parseUploadRequest accepts supported CSV and XLSX metadata', () => {
    assert.deepEqual(parseUploadRequest({ fileName: 'leads.csv', contentType: 'text/csv', fileSize: 100 }, maxFileSize), {
        fileName: 'leads.csv',
        contentType: 'text/csv',
        fileSize: 100,
        extension: 'csv'
    })
    assert.equal(
        parseUploadRequest(
            {
                fileName: 'leads.xlsx',
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                fileSize: 100
            },
            maxFileSize
        ).extension,
        'xlsx'
    )
})

void test('parseUploadRequest rejects unsupported files, MIME types, and sizes', () => {
    assert.throws(() => parseUploadRequest({ fileName: 'leads.pdf', contentType: 'application/pdf', fileSize: 100 }, maxFileSize), TransferInputError)
    assert.throws(() => parseUploadRequest({ fileName: 'leads.csv', contentType: 'application/pdf', fileSize: 100 }, maxFileSize), /contentType is invalid/)
    assert.throws(() => parseUploadRequest({ fileName: 'leads.csv', contentType: 'text/csv', fileSize: maxFileSize + 1 }, maxFileSize), /fileSize is invalid/)
})

void test('parseTransferFormat only allows CSV and XLSX exports', () => {
    assert.equal(parseTransferFormat('csv'), 'csv')
    assert.equal(parseTransferFormat('xlsx'), 'xlsx')
    assert.throws(() => parseTransferFormat('pdf'), /format must be csv or xlsx/)
})
