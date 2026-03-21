# Hackathon — subir a GitHub e integrar al equipo

Tu repo local ya está en la rama **`main`** con un commit inicial. Falta crear el remoto en GitHub y hacer **push** (vos usás **SSH**).

## 1. Crear el repositorio en GitHub

### Opción A — desde la web (simple)

1. Entrá a **[github.com/new](https://github.com/new)**.
2. **Repository name:** por ejemplo **`aleph-hackathon-m2026`** (repo del equipo en GitHub).
3. **Público** suele ser lo habitual en hackathons (o privado si el evento lo pide).
4. **No marques** “Add a README” ni .gitignore (el proyecto ya los tiene).
5. Crear repositorio.

### Opción B — con GitHub CLI

En tu Mac (con `gh auth login` ya hecho):

```bash
gh config set git_protocol ssh
cd /Users/Personal/ghost-tip-wallet
gh repo create aleph-hackathon-m2026 --public --source=. --remote=origin --push
```

Cambiá `--public` por `--private` si lo necesitás. Si el repo **ya existe** en la web, solo añadí el remoto (paso 2) y hacé `git push`.

## 2. Enlazar `origin` y subir (SSH)

Repo del equipo: **`Simonethg/aleph-hackathon-m2026`**.

**HTTPS:**

```bash
cd /Users/Personal/ghost-tip-wallet
git remote add origin https://github.com/Simonethg/aleph-hackathon-m2026.git
git push -u origin main
```

Si `origin` ya existe:

```bash
git remote set-url origin https://github.com/Simonethg/aleph-hackathon-m2026.git
git push -u origin main
```

**SSH (si preferís):**

```bash
git remote set-url origin git@github.com:Simonethg/aleph-hackathon-m2026.git
git push -u origin main
```

## 3. Invitar a tus compañeros

En GitHub: repo → **Settings** → **Collaborators** (o **Manage access**) → **Add people**.

Les mandás el enlace del repo:  
`https://github.com/Simonethg/aleph-hackathon-m2026`

## 4. Qué hacen tus compañeros la primera vez

```bash
git clone https://github.com/Simonethg/aleph-hackathon-m2026.git
cd aleph-hackathon-m2026
npm install
npm run dev
```

o por SSH:

```bash
git clone git@github.com:Simonethg/aleph-hackathon-m2026.git
cd aleph-hackathon-m2026
npm install
npm run dev
```


## 5. Flujo mínimo para no pisarse

1. Antes de empezar: `git pull origin main`.
2. Cada uno commitea en su máquina y hace `git push`.
3. Si dos tocaron lo mismo: el segundo hace `git pull` (o `git pull --rebase origin main`), resuelve conflictos si aparecen, y vuelve a `git push`.

Para más orden, podés usar ramas por tarea (`feature/nombre`) y **Pull Requests** en GitHub; para un hackathon corto, a veces basta **todo en `main`** con buen `pull` antes de trabajar.

## 6. Variables y secretos

Si más adelante usan API keys o RPC, **no las suban al repo**. Usen `.env` local (y añadan `.env` al `.gitignore` si aún no está) o los **Secrets** de GitHub Actions si automatizan deploy.

---

**Resumen:** creá el repo vacío en GitHub → `git remote add origin git@github.com:USUARIO/REPO.git` → `git push -u origin main` → invitá colaboradores → el equipo clona e instala con `npm install`.
