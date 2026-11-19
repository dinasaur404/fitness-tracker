import js from '@eslint/js'
import globals from 'globals'

export default [
  { files: ['tests/**/*.js', 'src/frontend/utils/**/*.js'] },
  { ignores: ['dist/**', 'node_modules/**', 'src/**/*.ts', 'src/**/*.jsx'] },
  js.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
]
