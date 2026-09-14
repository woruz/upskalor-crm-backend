/** @type {import('@commitlint/types').UserConfig} */
export default {
    extends: ['@commitlint/config-conventional'],

    rules: {
        // 🔹 Type must be one of these
        'type-enum': [2, 'always', ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore', 'perf', 'ci', 'build', 'revert']],

        // 🔹 Type must not be empty
        'type-empty': [2, 'never'],

        // 🔹 Subject must not be empty
        'subject-empty': [2, 'never'],

        // 🔹 Max header length
        'header-max-length': [2, 'always', 100],

        // 🔹 Subject should be lowercase (optional but recommended)
        'subject-case': [2, 'never', ['sentence-case', 'start-case', 'pascal-case']],

        // 🔹 Scope case (optional)
        'scope-case': [2, 'always', 'kebab-case']
    }
}

