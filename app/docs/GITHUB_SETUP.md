# Conectar este proyecto con GitHub

Tu identidad en Git (commits) debe coincidir con la de tu cuenta de GitHub:

```bash
cd ~/nozkash

git config user.name "Simonethg"
git config user.email "simonethfernandez@gmail.com"
```

Usá `--global` en lugar de configurar solo en esta carpeta si querés el mismo nombre y correo en todos tus repos:

```bash
git config --global user.name "Simonethg"
git config --global user.email "simonethfernandez@gmail.com"
```

## 1. Inicializar Git (si aún no hay repo válido)

En **Terminal.app** o **iTerm** (no hace falta que sea dentro de Cursor):

```bash
cd ~/nozkash

# Si .git está roto o vacío, borrarlo y empezar de nuevo:
rm -rf .git

git init
git add -A
git commit -m "chore: initial commit v1.0.0 (eGhostCash wallet)"
```

`node_modules` y `dist` están en `.gitignore` y no se suben.

## 2. Iniciar sesión en GitHub (CLI)

Si tenés [GitHub CLI](https://cli.github.com/) (`gh`):

```bash
gh auth login
```

Elegí **GitHub.com**, **HTTPS** o **SSH** según prefieras, y completá el login en el navegador.

## 3. Crear el repositorio remoto y subir el código

### Opción A — con `gh` (recomendado)

Desde la carpeta del proyecto:

```bash
cd ~/nozkash
gh repo create nozkash --private --source=. --remote=origin --push
```

Podés cambiar `nozkash` por el nombre de repo que quieras en GitHub. Quita `--private` si querés el repo **público**.

### Opción B — manual en github.com

1. Entrá a [github.com/new](https://github.com/new) y creá un repo **sin** README ni `.gitignore` (repo vacío).
2. En la terminal:

```bash
cd ~/nozkash
git remote add origin https://github.com/Simonethg/NOMBRE_DEL_REPO.git
git branch -M main
git push -u origin main
```

Sustituí `Simonethg` y `NOMBRE_DEL_REPO` por tu usuario y el nombre del repo.

## 4. Verificar el correo en GitHub

En GitHub: **Settings → Emails** — asegurate de que `simonethfernandez@gmail.com` esté añadido y verificado para que los commits se asocien bien a tu perfil.

---

Si algo falla al hacer `git init` dentro de Cursor, usá siempre la **Terminal del sistema** en la carpeta del proyecto (p. ej. `~/nozkash`).
