# Spread & Quality

Sistema de analise de Renda Fixa para mesa institucional. Cruza Catalogo XP +
ANBIMA + B3 secundario + Tesouro Direto online para identificar oportunidades
de alocacao, validar fair-value e medir liquidez real dos papeis.

## Pre-requisitos

- Python 3.10 ou superior
- pip
- git (para versionamento e deploy)

## Instalacao local

```bash
# 1. Clone o repositorio
git clone <URL-DO-SEU-REPO>
cd "Spread & quality"

# 2. Crie um ambiente virtual (recomendado)
python3 -m venv .venv
source .venv/bin/activate           # Linux/Mac
# .venv\Scripts\activate            # Windows

# 3. Instale dependencias
pip install -r requirements.txt

# 4. Configure variaveis de ambiente
cp .env.example .env
# Edite .env com suas credenciais

# 5. Rode o servidor
python3 app.py
```

Acesse `http://localhost:5001` no navegador.

## Credenciais

Por padrao:
- Usuario: `admin`
- Senha: `spreadquality`

**Mude isso antes de produzir!** Para trocar a senha:

```bash
# Gere o hash SHA-256 da nova senha:
python3 -c "import hashlib; print(hashlib.sha256(b'minhasenhaaqui').hexdigest())"

# Cole o resultado em APP_PASS_HASH no .env
```

## Tutorial: subir o projeto para o GitHub

### Passo 1 - Criar conta e repositorio no GitHub

1. Acesse https://github.com e crie uma conta (se nao tiver)
2. Clique em "New repository" (botao verde no topo direito)
3. Nome do repo: `spread-and-quality` (ou outro)
4. Marque **Private** (recomendado - dados sensiveis)
5. NAO marque "Initialize with README" (vamos enviar o nosso)
6. Clique "Create repository"

### Passo 2 - Configurar git local (1a vez)

```bash
git config --global user.name "Seu Nome"
git config --global user.email "seu.email@empresa.com"
```

### Passo 3 - Autenticacao com SSH (recomendado)

```bash
# Gera chave SSH
ssh-keygen -t ed25519 -C "seu.email@empresa.com"
# Aperte Enter nas 3 perguntas (aceitar defaults)

# Mostra a chave publica para copiar
cat ~/.ssh/id_ed25519.pub
```

Cole essa chave em https://github.com/settings/keys -> "New SSH key".

### Passo 4 - Inicializar e enviar o repositorio

```bash
cd "/Users/rodrigo/Projects/Spread & quality"

# Inicializa o repo
git init
git branch -M main

# Adiciona TUDO (o .gitignore ja exclui dados sensiveis)
git add .

# IMPORTANTE: verifique antes do commit se nao tem .env, dados de cliente,
# senhas no diff:
git status
git diff --staged | head -50

# Se ok, commita
git commit -m "Versao inicial - Spread & Quality"

# Conecta com o GitHub (substitua o URL pelo do SEU repo)
git remote add origin git@github.com:SEU-USUARIO/spread-and-quality.git

# Envia
git push -u origin main
```

### Passo 5 - Compartilhar com colegas

No repo do GitHub:
1. Aba **Settings** -> **Collaborators**
2. Adicione os emails dos colegas
3. Eles recebem convite por email

Cada colega clona com:

```bash
git clone git@github.com:SEU-USUARIO/spread-and-quality.git
cd spread-and-quality
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edite .env com a senha real (combinada com voce)
python3 app.py
```

### Passo 6 - Atualizar o codigo quando voce fizer mudancas

```bash
# Salvar mudancas locais
git add .
git commit -m "Descricao do que mudou"
git push

# Colegas baixam suas mudancas
git pull
```

## Estrutura do projeto

```
.
|-- app.py                  # Backend Flask (rotas, parsers, analytics)
|-- static/
|   |-- app.js              # Frontend JS
|   |-- style.css           # Estilos
|-- templates/
|   |-- index.html          # UI principal
|   |-- login.html          # Tela de login
|-- tests/
|   |-- test_parsers.py     # Testes unitarios
|-- requirements.txt        # Dependencias Python
|-- .env.example            # Template de variaveis de ambiente
|-- .gitignore              # Arquivos a NAO versionar
|-- README.md               # Este arquivo
```

## Avisos de seguranca

1. **NUNCA comite o arquivo `.env`** - ele tem senhas. Ja esta no .gitignore.
2. **NUNCA comite arquivos `.xlsx/.csv` com dados de clientes** - ja esta no .gitignore.
3. Em producao, use HTTPS (nginx/caddy/cloudflare na frente do Flask).
4. Mude a `SECRET_KEY` e o `APP_PASS_HASH` antes de expor publicamente.
5. Para deploy em servidor, prefira gunicorn:
   ```bash
   pip install gunicorn
   gunicorn -w 4 -b 0.0.0.0:5001 app:app
   ```

## Testes

```bash
python3 -m unittest discover tests
```

## Suporte

Em caso de problemas, abra uma issue no GitHub do projeto.
