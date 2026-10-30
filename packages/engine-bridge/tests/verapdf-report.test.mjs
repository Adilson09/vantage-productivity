import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseVeraPdfReport } from '../src/verapdf-report.mjs'

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/verapdf-1.30.3-reports.json', import.meta.url), 'utf8'),
)
const valid = fixture.cases.find((item) => item.name === 'pdfa-1b-pass.pdf')
const invalid = fixture.cases.find((item) => item.name === 'pdfa-1b-fail.pdf')
const processFor = (item) => ({ code: item.code, stdout: JSON.stringify(item.report), stderr: '' })
for (const item of fixture.cases) {
  test('actual veraPDF report: ' + item.name, () => {
    const result = parseVeraPdfReport(processFor(item), {
      flavour: item.flavour,
      expectedPath: '/fixtures/' + item.name,
    })
    assert.equal(
      result.status,
      item.code === 7 ? 'incomplete' : item.expectedCompliant ? 'pass' : 'fail',
    )
    assert.equal(result.conformance.complete, item.code !== 7)
    if (result.conformance.complete) {
      assert.equal(result.conformance.profiles[0].id, item.flavour)
      assert.equal(result.conformance.profiles[0].compliant, item.expectedCompliant)
    }
  })
}

const mutations = [
  [
    'missing report',
    (r) => {
      delete r.report
    },
  ],
  [
    'missing job',
    (r) => {
      r.report.jobs = []
    },
  ],
  [
    'additional job',
    (r) => {
      r.report.jobs.push(structuredClone(r.report.jobs[0]))
    },
  ],
  [
    'batch count disagrees',
    (r) => {
      r.report.batchSummary.totalJobs = 0
    },
  ],
  [
    'batch multi-job marker',
    (r) => {
      r.report.batchSummary.multiJob = true
    },
  ],
  [
    'task exception despite a pass',
    (r) => {
      r.report.jobs[0].taskException = { message: 'parse failure' }
    },
  ],
  [
    'omitted normal completion',
    (r) => {
      delete r.report.jobs[0].validationResult[0].jobEndStatus
    },
  ],
  [
    'interrupted profile',
    (r) => {
      r.report.jobs[0].validationResult[0].jobEndStatus = 'timeout'
    },
  ],
  [
    'string compliance flag',
    (r) => {
      r.report.jobs[0].validationResult[0].compliant = 'true'
    },
  ],
  [
    'XML compliance flag only',
    (r) => {
      const p = r.report.jobs[0].validationResult[0]
      delete p.compliant
      p.isCompliant = true
    },
  ],
  [
    'unknown profile',
    (r) => {
      r.report.jobs[0].validationResult[0].profileName = 'Everything is accessible'
    },
  ],
  [
    'wrong requested profile',
    (r) => {
      r.report.jobs[0].validationResult[0].profileName = 'PDF/UA-1 validation profile'
    },
  ],
  [
    'missing profile results',
    (r) => {
      r.report.jobs[0].validationResult = []
    },
  ],
  [
    'duplicate profile results',
    (r) => {
      r.report.jobs[0].validationResult.push(structuredClone(r.report.jobs[0].validationResult[0]))
    },
  ],
  [
    'negative rule count',
    (r) => {
      r.report.jobs[0].validationResult[0].details.passedRules = -1
    },
  ],
  [
    'string check count',
    (r) => {
      r.report.jobs[0].validationResult[0].details.passedChecks = '553'
    },
  ],
  [
    'unsafe numeric count',
    (r) => {
      r.report.jobs[0].validationResult[0].details.passedChecks = 2 ** 54
    },
  ],
  [
    'failed checks behind a pass',
    (r) => {
      r.report.jobs[0].validationResult[0].details.failedChecks = 1
    },
  ],
  [
    'empty validation behind a pass',
    (r) => {
      Object.assign(r.report.jobs[0].validationResult[0].details, {
        passedRules: 0,
        passedChecks: 0,
      })
    },
  ],
  [
    'failed parsing counter',
    (r) => {
      r.report.batchSummary.failedParsingJobs = 1
    },
  ],
  [
    'missing parsing counter',
    (r) => {
      delete r.report.batchSummary.failedParsingJobs
    },
  ],
  [
    'failed encrypted counter',
    (r) => {
      r.report.batchSummary.failedEncryptedJobs = 1
    },
  ],
  [
    'out of memory counter',
    (r) => {
      r.report.batchSummary.outOfMemory = 1
    },
  ],
  [
    'validator exception counter',
    (r) => {
      r.report.batchSummary.veraExceptions = 1
    },
  ],
  [
    'failed validation job counter',
    (r) => {
      r.report.batchSummary.validationSummary.failedJobCount = 1
    },
  ],
  [
    'zero successful jobs',
    (r) => {
      r.report.batchSummary.validationSummary.successfulJobCount = 0
    },
  ],
  [
    'wrong compliance summary',
    (r) => {
      r.report.batchSummary.validationSummary.nonCompliantPdfaCount = 1
    },
  ],
  [
    'unexpected metadata repair',
    (r) => {
      r.report.batchSummary.repairSummary.totalJobCount = 1
    },
  ],
  [
    'unexpected feature operation',
    (r) => {
      r.report.batchSummary.featuresSummary.totalJobCount = 1
    },
  ],
  [
    'wrong input',
    (r) => {
      r.report.jobs[0].itemDetails.name = '/fixtures/different.pdf'
    },
  ],
]
for (const [label, mutate] of mutations) {
  test('fails closed on ' + label, () => {
    const report = structuredClone(valid.report)
    mutate(report)
    assert.equal(
      parseVeraPdfReport(
        { code: 0, stdout: JSON.stringify(report) },
        {
          flavour: '1b',
          expectedPath: '/fixtures/pdfa-1b-pass.pdf',
          expectedBytes: 10231,
        },
      ).status,
      'incomplete',
    )
  })
}
test('rejects truncated, trailing, oversized and non-JSON reports', () => {
  for (const stdout of [
    '',
    '{"report":',
    JSON.stringify(valid.report) + '{}',
    '<report isCompliant="true"/>',
    ' '.repeat(4 * 1024 * 1024 + 1),
  ])
    assert.equal(parseVeraPdfReport({ code: 0, stdout }).status, 'incomplete')
})
test('rejects duplicate compliance keys, including escaped aliases, and excessive nesting', () => {
  const validText = JSON.stringify(valid.report)
  for (const duplicate of [
    '"compliant":false,"compliant":true',
    '"compliant":false,"\\u0063ompliant":true',
  ]) {
    const stdout = validText.replace('"compliant":true', duplicate)
    assert.notEqual(stdout, validText)
    assert.equal(parseVeraPdfReport({ code: 0, stdout }).status, 'incomplete')
  }
  const stdout = '{"padding":' + '['.repeat(100) + '0' + ']'.repeat(100) + ',' + validText.slice(1)
  assert.equal(parseVeraPdfReport({ code: 0, stdout }).status, 'incomplete')
})
test('exit status, cancellation and memory failure cannot become compliance', () => {
  for (const code of [null, 1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 255])
    assert.equal(parseVeraPdfReport({ ...processFor(valid), code }).status, 'incomplete')
  for (const stopped of ['timeout', 'cancelled', 'output-limit', 'unavailable'])
    assert.equal(parseVeraPdfReport({ ...processFor(valid), stopped }).status, 'incomplete')
  assert.equal(parseVeraPdfReport({ ...processFor(invalid), code: 0 }).status, 'incomplete')
})
test('auto mode returns every checked profile and uses the job summary', () => {
  const report = structuredClone(valid.report)
  const second = structuredClone(invalid.report.report.jobs[0].validationResult[0])
  second.profileName = 'PDF/UA-1 validation profile'
  report.report.jobs[0].validationResult.push(second)
  Object.assign(report.report.batchSummary.validationSummary, {
    compliantPdfaCount: 0,
    nonCompliantPdfaCount: 1,
  })
  const result = parseVeraPdfReport({ code: 1, stdout: JSON.stringify(report) })
  assert.equal(result.status, 'fail')
  assert.deepEqual(
    result.conformance.profiles.map((p) => [p.id, p.compliant]),
    [
      ['1b', true],
      ['ua1', false],
    ],
  )
})
