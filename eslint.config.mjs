import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import eslintConfigPrettier from 'eslint-config-prettier'

export default [
    // Ignore build & config files
    {
        ignores: ['dist', 'node_modules', 'coverage', '*.config.js', '*.config.mjs']
    },

    // Base JS recommended config
    js.configs.recommended,

    // TypeScript config
    ...tseslint.configs.recommended,

    // Prettier config
    eslintConfigPrettier,

    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parser: tseslint.parser,
            parserOptions: {
                project: './tsconfig.json' // needed for strict rules
            },
            globals: {
                ...globals.node
            }
        },

        plugins: {
            '@typescript-eslint': tseslint.plugin
        },

        rules: {
            // 🔹 General
            'no-console': 'error',
            'no-debugger': 'error',

            // 🔹 TypeScript strictness
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
            '@typescript-eslint/no-floating-promises': 'error',

            // 🔥 VERY IMPORTANT
            '@typescript-eslint/no-misused-promises': 'error',
            '@typescript-eslint/await-thenable': 'error',

            // 🔥 Code quality
            eqeqeq: ['error', 'always'],
            curly: ['error', 'all'],
            'no-var': 'error',
            'prefer-const': 'error',

            // 🔥 Safety
            'no-throw-literal': 'error',
            'no-return-await': 'error',

            // 🔥 Optional strictness
            '@typescript-eslint/explicit-function-return-type': 'warn'
        }
    }
]
