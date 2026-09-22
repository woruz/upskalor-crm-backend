import assert from 'node:assert/strict'
import test from 'node:test'

import {
    CONNECTION_TYPES,
    parsePhotoInput,
    parseSurveyFilters,
    parseSurveyInput,
    SHADING_OPTIONS,
    SURVEY_STATUSES,
    SurveyConflictError,
    SurveyForbiddenError,
    SurveyInputError,
    validateStatusTransition
} from './surveys.js'

const validSurveyPayload = {
    customerName: 'Rahul Sharma',
    mobileNumber: '+919876543210',
    address: '123 Solar Street, Pune',
    surveyDateTime: '2026-10-15T14:30:00.000Z',
    assignedTechId: '123e4567-e89b-12d3-a456-426614174000',
    assignedTech: 'Tech Rajesh',
    roofAreaSqft: 1200.5,
    shading: 'Partial',
    connectionType: 'Three-phase',
    sanctionedLoadKw: 10,
    monthlyConsumptionKwh: 450,
    recommendedKw: 6,
    latitude: '18.5204',
    longitude: '73.8567',
    notes: 'South facing roof with good exposure'
}

void test('SURVEY_STATUSES, SHADING_OPTIONS, CONNECTION_TYPES enums contain expected values', () => {
    assert.deepEqual(SURVEY_STATUSES, ['Scheduled', 'In Progress', 'Completed', 'Cancelled'])
    assert.deepEqual(SHADING_OPTIONS, ['None', 'Partial', 'Heavy'])
    assert.deepEqual(CONNECTION_TYPES, ['Three-phase', 'Single-phase'])
})

void test('parseSurveyInput normalizes a valid survey payload', () => {
    const parsed = parseSurveyInput(validSurveyPayload)

    assert.equal(parsed.customerName, 'Rahul Sharma')
    assert.equal(parsed.mobileNumber, '+919876543210')
    assert.equal(parsed.address, '123 Solar Street, Pune')
    assert.ok(parsed.surveyDateTime instanceof Date)
    assert.equal(parsed.assignedTechId, '123e4567-e89b-12d3-a456-426614174000')
    assert.equal(parsed.assignedTech, 'Tech Rajesh')
    assert.equal(parsed.roofAreaSqft, 1200.5)
    assert.equal(parsed.shading, 'Partial')
    assert.equal(parsed.connectionType, 'Three-phase')
    assert.equal(parsed.sanctionedLoadKw, 10)
    assert.equal(parsed.monthlyConsumptionKwh, 450)
    assert.equal(parsed.recommendedKw, 6)
    assert.equal(parsed.latitude, '18.5204')
    assert.equal(parsed.longitude, '73.8567')
    assert.equal(parsed.notes, 'South facing roof with good exposure')
})

void test('parseSurveyInput permits missing customer info when leadId is supplied', () => {
    const parsed = parseSurveyInput({
        leadId: '123e4567-e89b-12d3-a456-426614174000',
        surveyDateTime: '2026-10-15T14:30:00.000Z'
    })

    assert.equal(parsed.leadId, '123e4567-e89b-12d3-a456-426614174000')
    assert.ok(parsed.surveyDateTime instanceof Date)
})

void test('parseSurveyInput rejects missing customerName or mobileNumber when leadId is absent', () => {
    assert.throws(
        () => parseSurveyInput({ surveyDateTime: '2026-10-15T14:30:00.000Z' }),
        (err: unknown) => {
            assert.ok(err instanceof SurveyInputError)
            assert.ok(err.details?.['customerName'])
            assert.ok(err.details?.['mobileNumber'])
            return true
        }
    )
})

void test('parseSurveyInput rejects invalid mobile numbers with less than 10 digits', () => {
    assert.throws(
        () => parseSurveyInput({ ...validSurveyPayload, mobileNumber: '12345' }),
        (err: unknown) => {
            assert.ok(err instanceof SurveyInputError)
            assert.ok(err.details?.['mobileNumber'])
            return true
        }
    )
})

void test('parseSurveyInput rejects negative technical specifications', () => {
    assert.throws(
        () => parseSurveyInput({ ...validSurveyPayload, roofAreaSqft: -5 }),
        (err: unknown) => {
            assert.ok(err instanceof SurveyInputError)
            assert.ok(err.details?.['roofAreaSqft'])
            return true
        }
    )
    assert.throws(
        () => parseSurveyInput({ ...validSurveyPayload, sanctionedLoadKw: -1 }),
        (err: unknown) => {
            assert.ok(err instanceof SurveyInputError)
            assert.ok(err.details?.['sanctionedLoadKw'])
            return true
        }
    )
})

void test('parseSurveyInput validates coordinate boundaries', () => {
    assert.throws(
        () => parseSurveyInput({ ...validSurveyPayload, latitude: '95.123' }),
        (err: unknown) => {
            assert.ok(err instanceof SurveyInputError)
            assert.ok(err.details?.['latitude'])
            return true
        }
    )
    assert.throws(
        () => parseSurveyInput({ ...validSurveyPayload, longitude: '-185.0' }),
        (err: unknown) => {
            assert.ok(err instanceof SurveyInputError)
            assert.ok(err.details?.['longitude'])
            return true
        }
    )
})

void test('parseSurveyInput validates enum options for shading and connectionType', () => {
    assert.throws(
        () => parseSurveyInput({ ...validSurveyPayload, shading: 'InvalidShading' }),
        (err: unknown) => {
            assert.ok(err instanceof SurveyInputError)
            assert.ok(err.details?.['shading'])
            return true
        }
    )
    assert.throws(
        () => parseSurveyInput({ ...validSurveyPayload, connectionType: 'InvalidPhase' }),
        (err: unknown) => {
            assert.ok(err instanceof SurveyInputError)
            assert.ok(err.details?.['connectionType'])
            return true
        }
    )
})

void test('parseSurveyFilters supports pagination, search, status, and role scoping', () => {
    const filters = parseSurveyFilters(
        new URL(
            'http://localhost/surveys?page=2&limit=15&search=Rahul&status=Scheduled&assignedTechId=123e4567-e89b-12d3-a456-426614174000&leadId=123e4567-e89b-12d3-a456-426614174001&dateFrom=2026-10-01T00:00:00Z&dateTo=2026-10-31T23:59:59Z&sort=surveyDateTime&direction=asc'
        ),
        'admin',
        '123e4567-e89b-12d3-a456-426614174099'
    )

    assert.equal(filters.page, 2)
    assert.equal(filters.limit, 15)
    assert.equal(filters.search, 'Rahul')
    assert.equal(filters.status, 'Scheduled')
    assert.equal(filters.assignedTechId, '123e4567-e89b-12d3-a456-426614174000')
    assert.equal(filters.leadId, '123e4567-e89b-12d3-a456-426614174001')
    assert.ok(filters.dateFrom instanceof Date)
    assert.ok(filters.dateTo instanceof Date)
    assert.equal(filters.sort, 'surveyDateTime')
    assert.equal(filters.direction, 'asc')
})

void test('parseSurveyFilters automatically scopes technician (user role) to their own userId', () => {
    const techUserId = '123e4567-e89b-12d3-a456-426614174099'
    const filters = parseSurveyFilters(new URL('http://localhost/surveys'), 'user', techUserId)

    assert.equal(filters.assignedTechId, techUserId)
})

void test('parseSurveyFilters rejects invalid page size, sort, and date ranges', () => {
    assert.throws(() => parseSurveyFilters(new URL('http://localhost/surveys?limit=150')), SurveyInputError)
    assert.throws(() => parseSurveyFilters(new URL('http://localhost/surveys?sort=unknown')), SurveyInputError)
    assert.throws(() => parseSurveyFilters(new URL('http://localhost/surveys?direction=sideways')), SurveyInputError)
    assert.throws(
        () => parseSurveyFilters(new URL('http://localhost/surveys?dateFrom=2026-11-01&dateTo=2026-10-01')),
        SurveyInputError
    )
})

void test('parsePhotoInput validates required photo attributes', () => {
    const photo = parsePhotoInput({
        fileUrl: 'https://storage.upskalor.com/surveys/roof.jpg',
        fileName: 'roof.jpg',
        fileSizeBytes: 2048500,
        mimeType: 'image/jpeg'
    })

    assert.equal(photo.fileUrl, 'https://storage.upskalor.com/surveys/roof.jpg')
    assert.equal(photo.fileName, 'roof.jpg')
    assert.equal(photo.fileSizeBytes, 2048500)
    assert.equal(photo.mimeType, 'image/jpeg')

    assert.throws(() => parsePhotoInput({}), SurveyInputError)
    assert.throws(() => parsePhotoInput({ fileUrl: 'https://example.com/1.jpg' }), SurveyInputError)
})

void test('validateStatusTransition enforces state machine transitions', () => {
    // Scheduled transitions
    assert.doesNotThrow(() => validateStatusTransition('Scheduled', 'In Progress'))
    assert.doesNotThrow(() => validateStatusTransition('Scheduled', 'Completed'))
    assert.doesNotThrow(() => validateStatusTransition('Scheduled', 'Cancelled'))

    // In Progress transitions
    assert.doesNotThrow(() => validateStatusTransition('In Progress', 'Completed'))
    assert.doesNotThrow(() => validateStatusTransition('In Progress', 'Cancelled'))
    assert.doesNotThrow(() => validateStatusTransition('In Progress', 'Scheduled'))

    // Cancelled -> Scheduled (Reopening)
    assert.doesNotThrow(() => validateStatusTransition('Cancelled', 'Scheduled'))

    // Completed -> Cancelled: Admin allowed, standard user forbidden
    assert.doesNotThrow(() => validateStatusTransition('Completed', 'Cancelled', 'admin'))
    assert.doesNotThrow(() => validateStatusTransition('Completed', 'Cancelled', 'super_admin'))
    assert.throws(() => validateStatusTransition('Completed', 'Cancelled', 'user'), SurveyForbiddenError)

    // Disallowed transitions
    assert.throws(() => validateStatusTransition('Completed', 'In Progress'), SurveyConflictError)
    assert.throws(() => validateStatusTransition('Completed', 'Scheduled'), SurveyConflictError)
    assert.throws(() => validateStatusTransition('Cancelled', 'Completed'), SurveyConflictError)
})
