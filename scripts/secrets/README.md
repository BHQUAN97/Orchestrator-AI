# Secrets workflow cho repo nay

## File layout
| File | Commit? | Muc dich |
|---|---|---|
| `.env.example` | YES | Template, chi ten key |
| `.env` | NO | Dev local (copy tu example) |
| `.env.prod` | NO | Prod plaintext (tam thoi khi edit) |
| `.env.prod.enc` | YES | Prod encrypted (SOPS + age) |
| `.sops.yaml` | YES | SOPS config |

## Workflow

### Dev local
```bash
cp .env.example .env
# Sua .env theo setup may minh
```

### Them / sua secret prod
```bash
# 1. Decrypt (neu chua co .env.prod)
bash scripts/secrets/decrypt.sh prod

# 2. Sua .env.prod bang text editor

# 3. Encrypt lai
bash scripts/secrets/encrypt.sh prod

# 4. Sync len GitHub Actions (tu dong)
bash scripts/secrets/sync-gh.sh prod

# 5. Commit ban encrypted
git add .env.prod.enc
git commit -m "chore(secrets): update prod env"
git push

# 6. Xoa plaintext local
rm .env.prod
```

### Deploy tren VPS
```bash
git pull
bash scripts/secrets/decrypt.sh prod
# App se doc .env.prod
pm2 restart ecosystem.config.js
```

## Yeu cau tren VPS (lam 1 lan)
1. Cai sops: `curl -L https://github.com/getsops/sops/releases/latest/download/sops-linux-amd64 -o /usr/local/bin/sops && chmod +x /usr/local/bin/sops`
2. Copy age private key: upload `~/.config/sops/age/keys.txt` len VPS (scp)
3. Set env: `echo 'export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt' >> ~/.bashrc`

## Quen age key?
Khong decrypt duoc nua! Luon BACKUP `~/.config/sops/age/keys.txt` vao password manager.
