# Build Mode — Coding Standards

## JavaScript / Node.js
- CommonJS (require) cho backend, ES modules neu co "type":"module"
- Error handling: try/catch cho async, .catch() cho promises
- Khong dung var, chi const/let

## File moi
- Moi file phai co header comment: muc dich, cach dung
- Moi function > 20 dong: comment muc dich

## Test
- Chay test sau moi thay doi: npm test hoac node script
- Verify build: npm run build (neu co)

## Git
- Stage tung file, khong dung git add -A
- Commit message: type(scope): mo ta ngan
