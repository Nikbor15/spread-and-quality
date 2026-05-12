from flask import Flask, request, jsonify, render_template, session, g, redirect, url_for
import pandas as pd
import numpy as np
import io, os, re, unicodedata, uuid, time, threading, hashlib
from functools import wraps


def _load_dotenv():
    """Carrega .env local (se existir) em os.environ. Sem dependencia externa.
    Formato: KEY=VALUE por linha; comentarios com #; aspas opcionais."""
    path = os.path.join(os.path.dirname(__file__) or '.', '.env')
    if not os.path.isfile(path):
        return
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                if '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k = k.strip(); v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


_load_dotenv()

app = Flask(__name__)
# 300MB — arquivos B3 oficiais (negociacao consolidada do dia) costumam ter
# 150-200MB. Os demais (ANBIMA/XP) ficam abaixo de 5MB. 300 cobre folga.
app.config['MAX_CONTENT_LENGTH'] = 300 * 1024 * 1024
# Secret key para Flask session — em prod, defina via variável de ambiente.
app.secret_key = os.environ.get('SECRET_KEY', 'spread-quality-dev-key-change-me')

# ----- AUTENTICACAO ---------------------------------------------------------
# Login simples via variaveis de ambiente. NUNCA comitar senhas — usar
# APP_USER e APP_PASS_HASH (sha256 da senha) no .env local ou nas secrets
# do servidor. Default = admin / spreadquality (DEV ONLY — mude em prod).
#
# Para gerar um novo hash:
#   python3 -c "import hashlib; print(hashlib.sha256(b'minhasenha').hexdigest())"

AUTH_USER      = os.environ.get('APP_USER', 'admin')
AUTH_PASS_HASH = os.environ.get('APP_PASS_HASH',
    hashlib.sha256(b'spreadquality').hexdigest())


def _check_password(pw):
    """Compara hash SHA-256 da senha digitada com o hash configurado."""
    return hashlib.sha256(pw.encode('utf-8')).hexdigest() == AUTH_PASS_HASH


def _is_public_path():
    """Rotas que dispensam autenticacao: login, logout, static, healthcheck."""
    ep = request.endpoint or ''
    if ep in ('login', 'logout', 'static', 'health'):
        return True
    return request.path.startswith('/static/')


@app.before_request
def _require_auth():
    if _is_public_path():
        return
    if not session.get('logged_in'):
        # Rotas /api/* devolvem 401; demais redirecionam para /login
        if request.path.startswith('/api/'):
            return jsonify({'error': 'autenticacao requerida'}), 401
        return redirect(url_for('login'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        u = (request.form.get('username') or '').strip()
        p = request.form.get('password') or ''
        if u == AUTH_USER and _check_password(p):
            session['logged_in'] = True
            session.permanent = True
            return redirect(url_for('index'))
        return render_template('login.html', error='Credenciais invalidas.'), 401
    return render_template('login.html', error=None)


@app.route('/logout')
def logout():
    session.pop('logged_in', None)
    return redirect(url_for('login'))


@app.route('/health')
def health():
    """Endpoint publico para health-check (load balancer / monitoring)."""
    return jsonify({'status': 'ok'})

# ── PER-SESSION STORE ────────────────────────────────────────────────────────
# Antes era um único dict global -> vazaria dados entre usuários se hospedado.
# Agora indexamos por session-id gerado pelo Flask. Cada aba/usuário tem o seu.
_user_stores: dict = {}        # sid -> store dict (dados de negócio)
_user_last_seen: dict = {}     # sid -> timestamp (rastreado fora do store)
_user_stores_lock = threading.Lock()

# Garbage-collect sessões inativas (≥ 6h sem upload nem fetch)
_SESSION_TTL_SEC = 6 * 3600


def _gc_sessions():
    """Remove sessões inativas > TTL. Chamado oportunisticamente."""
    now = time.time()
    with _user_stores_lock:
        stale = [sid for sid, t in _user_last_seen.items()
                 if now - t > _SESSION_TTL_SEC]
        for sid in stale:
            _user_stores.pop(sid, None)
            _user_last_seen.pop(sid, None)


@app.before_request
def _attach_store():
    if 'sid' not in session:
        session['sid'] = uuid.uuid4().hex
        session.permanent = True
    sid = session['sid']
    with _user_stores_lock:
        s = _user_stores.setdefault(sid, {})
        _user_last_seen[sid] = time.time()
    g.store = s
    # Oportunisticamente roda GC (chance baixa para não pesar)
    if uuid.uuid4().int % 64 == 0:
        _gc_sessions()


# Compat: muitos lugares ainda dizem `store[...]`. Definimos um proxy global
# que delega para `g.store`. Assim mudança fica cirúrgica.
class _StoreProxy:
    def __getitem__(self, k):     return g.store[k]
    def __setitem__(self, k, v):  g.store[k] = v
    def __delitem__(self, k):     del g.store[k]
    def __contains__(self, k):    return k in g.store
    def __iter__(self):           return iter(g.store)
    def get(self, *a, **kw):      return g.store.get(*a, **kw)
    def setdefault(self, *a, **kw): return g.store.setdefault(*a, **kw)
    def keys(self):               return g.store.keys()
    def values(self):             return g.store.values()
    def items(self):              return g.store.items()
    def __len__(self):            return len(g.store)


store = _StoreProxy()   # mantém API antiga; lê/escreve em g.store por request
# ── UTILS ───────────────────────────────────────────────────────────────────

def _safe(v):
    if v is None:
        return None
    # pd.isnull handles NaN, NaT, and None uniformly
    try:
        if pd.isnull(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.floating):
        return None if np.isnan(v) else round(float(v), 6)
    if isinstance(v, pd.Timestamp):
        return v.strftime('%d/%m/%Y')
    return v


def _num(s):
    """Parse numeric strings, handling both comma and period decimals.

    Heurística (compatível com formatos BR e ANGLO):
      '1.234,56'   -> 1234.56   (BR: dot-thousand, comma-decimal)
      '1.234.567'  -> 1234567   (BR: múltiplos dots -> milhar)
      '13,896'     -> 13.896    (BR: comma decimal)
      '13.896'     -> 13.896    (ANGLO: 1 dot + 3 dígitos -> ambíguo, mantém float
                                 — ANBIMA usa vírgula, então dot puro vem do anglo)
      '7.18'       -> 7.18      (ANGLO: dot decimal — duration etc.)
      '--'         -> None
    """
    if s is None:
        return None
    sv = str(s).strip()
    if sv in ('', '--', 'nan', 'NaN', 'N/D', 'None'):
        return None
    # If value already a float (pandas parsed it), return directly
    try:
        if isinstance(s, (int, float)):
            return float(s) if not (isinstance(s, float) and np.isnan(s)) else None
    except Exception:
        pass
    # European format: 1.234,56  -> remove dot-thousands first (must have comma after)
    if ',' in sv and '.' in sv:
        sv = sv.replace('.', '').replace(',', '.')
    elif ',' in sv:
        # Only comma -> treat as decimal separator
        sv = sv.replace(',', '.')
    elif sv.count('.') >= 2:
        # Múltiplos pontos sem vírgula -> BR thousand separator: 1.234.567 -> 1234567
        sv = sv.replace('.', '')
    # else: 1 ponto ou nenhum -> tratar como decimal (anglo) ou inteiro
    try:
        return float(sv)
    except ValueError:
        return None


def _safe_str(v):
    """Return clean string, or '' if the value is NaN/None/empty.
    Also strips ANBIMA footnote markers like (*), (1), * — but keeps them
    if they appear INSIDE the name (only trims trailing ones)."""
    if v is None:
        return ''
    s = str(v).strip()
    if s.lower() in ('nan', 'none', 'n/d', 'n/a', '-', ''):
        return ''
    # Trim trailing footnote markers: "  *", " (1)", " (*)", "(*)"
    s = re.sub(r'\s*\(\s*\*\s*\)\s*$', '', s)   # (*) — Recuperacao Judicial ANBIMA
    s = re.sub(r'\s*[\*†‡]\s*$', '', s)
    s = re.sub(r'\s*\(\d+\)\s*$', '', s)
    return s.strip()


def _has_rj(name_str):
    """Return True if ANBIMA name has (*) marker = Recuperação Judicial / default."""
    return bool(re.search(r'\(\s*\*\s*\)', str(name_str)) or str(name_str).endswith('*'))


def _norm(name):
    """Normalise company name for fuzzy matching."""
    if not name:
        return ''
    s = unicodedata.normalize('NFKD', str(name))
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = s.upper()
    s = re.sub(r'\b(S\.?/?A\.?|LTDA|EIRELI|CIA|CIA\.|COMPANHIA|DO BRASIL|DO ESTADO)\b', ' ', s)
    s = re.sub(r'[^\w\s]', ' ', s)
    return ' '.join(s.split())


def _parse_xp_rate(tax_str):
    """Extract (index_type, numeric_spread) from XP Tax.Mín strings.

    Returns:
        ('IPCA', 6.30)  for 'IPC-A + 6,30%'
        ('CDI+', 1.75)  for 'CDI + 1,75%'
        ('CDI%', 101.1) for '101,1% CDI'
        ('PRE', 15.14)  for '15,14%'
        ('IGPM', 6.55)  for 'IGP-M + 6,55%'
        ('DOLAR', 5.80) for 'DOLAR PTAX + 5,80%'
    """
    if not tax_str or str(tax_str).strip() in ('nan', ''):
        return None, None
    s = str(tax_str).replace(',', '.').upper()
    # Padrão de número: dígitos, opcionalmente seguidos de UM ponto e mais
    # dígitos. Antes era [\d.]+ que aceitava '5.35.99' e crashava no float().
    NUM = r'(\d+(?:\.\d+)?)'

    m = re.search(rf'(?:IPC-?A|IPCA)\s*\+\s*{NUM}', s)
    if m:
        return 'IPCA', float(m.group(1))

    m = re.search(rf'(?:CDI|DI)\s*\+\s*{NUM}', s)
    if m:
        return 'CDI+', float(m.group(1))

    m = re.search(rf'{NUM}%?\s*(?:CDI|DO\s*DI)', s)
    if m:
        return 'CDI%', float(m.group(1))

    m = re.search(rf'IGP-?M\s*\+\s*{NUM}', s)
    if m:
        return 'IGPM', float(m.group(1))

    m = re.search(rf'DOLAR.*?\+\s*{NUM}', s)
    if m:
        return 'DOLAR', float(m.group(1))

    m = re.match(rf'^{NUM}\s*%?$', s.strip())
    if m:
        return 'PRE', float(m.group(1))

    return None, None


def _sheet_to_type(sheet):
    return {
        'DI_PERCENTUAL': 'CDI%',
        'DI_SPREAD':     'CDI+',
        'IPCA_SPREAD':   'IPCA',
        'PREFIXADO':     'PRE',
        'IGP-M':         'IGPM',
    }.get(sheet)


def _infer_type_from_indice(indice_str):
    """Deduz o tipo de indexador a partir da string.
    Retorna None quando não reconhece — evitamos fallback silencioso para 'PRE'
    que mascarava indexadores desconhecidos como pré-fixado."""
    if not indice_str:
        return None
    s = str(indice_str).upper()
    if 'IPCA' in s or 'IPC-A' in s:
        return 'IPCA'
    if ('DI' in s or 'CDI' in s) and '+' in s:
        return 'CDI+'
    if 'DI' in s or 'CDI' in s:
        return 'CDI%'
    if 'IGP' in s:
        return 'IGPM'
    if 'PRE' in s or 'PRÉ' in s or 'PREFIX' in s:
        return 'PRE'
    return None


# ── PARSERS ─────────────────────────────────────────────────────────────────

def parse_anbima_cri_cra(fb):
    """precos-cri-cra.csv -> {codigo: {...}}"""
    df = pd.read_csv(fb, encoding='latin-1', sep=None, engine='python')
    df.columns = [c.strip() for c in df.columns]

    lookup = {}
    data_ref = None
    for _, row in df.iterrows():
        codigo = str(row.get('Código', '')).strip()
        if not codigo or codigo == 'nan':
            continue

        indice_str = str(row.get('Índice / Correção', '')).strip()
        if not data_ref:
            data_ref = str(row.get('Data de Referência', '')).strip()

        instr = 'CRA' if codigo.upper().startswith('CRA') else 'CRI'

        raw_emissor = str(row.get('Risco de Crédito', ''))
        lookup[codigo] = {
            'instrumento':    instr,
            'emissor':        _safe_str(raw_emissor),
            'rj':             _has_rj(raw_emissor),   # (*) = Recuperação Judicial
            'securitizadora': _safe_str(row.get('Emissor', '')),
            'vencimento':     _safe(row.get('Vencimento')),
            'indice_str':     indice_str,
            'indice_type':    _infer_type_from_indice(indice_str),
            'taxa_indicativa': _num(row.get('Taxa Indicativa')),
            'taxa_compra':    _num(row.get('Taxa Compra')),
            'taxa_venda':     _num(row.get('Taxa Venda')),
            'desvio':         _num(row.get('Desvio Padrão')),
            'pu':             _num(row.get('PU')),
            'duration':       _num(row.get('Duration')),
            'data_ref':       data_ref,
        }

    # Attach date to every entry
    for v in lookup.values():
        v['data_ref'] = data_ref
    return lookup


def parse_anbima_debentures(fb):
    """d26abr07.xls (ANBIMA debêntures) -> {codigo: {...}}"""
    xl = pd.ExcelFile(fb)
    lookup = {}

    # Extract reference date from any sheet
    df0 = xl.parse(xl.sheet_names[0], header=None, nrows=5)
    data_ref = None
    for _, r in df0.iterrows():
        for v in r.values:
            if isinstance(v, pd.Timestamp):
                data_ref = v.strftime('%d/%m/%Y')
                break
        if data_ref:
            break

    for sheet in xl.sheet_names:
        itype = _sheet_to_type(sheet)
        if itype is None:
            continue

        df = xl.parse(sheet, header=None, skiprows=9)
        if df.shape[1] < 10:
            continue

        cols = ['codigo', 'nome', 'vencimento', 'indice', 'taxa_compra', 'taxa_venda',
                'taxa_indicativa', 'desvio', 'int_min', 'int_max', 'pu',
                'pct_par', 'duration', 'pct_reune', 'ref_ntnb']
        df = df.iloc[:, :len(cols)]
        df.columns = cols[:df.shape[1]]

        for _, row in df.iterrows():
            codigo = str(row.get('codigo', '')).strip()
            if (not codigo or len(codigo) > 15
                    or codigo.lower().startswith('obs')
                    or codigo.startswith('(')
                    or codigo == 'nan'):
                continue

            raw_emissor = str(row.get('nome', ''))
            lookup[codigo] = {
                'instrumento':    'DEB',
                'emissor':        _safe_str(raw_emissor),
                'rj':             _has_rj(raw_emissor),
                'vencimento':     _safe(row.get('vencimento')),
                'indice_str':     str(row.get('indice', '')).strip(),
                'indice_type':    itype,
                'taxa_indicativa': _num(row.get('taxa_indicativa')),
                'taxa_compra':    _num(row.get('taxa_compra')),
                'taxa_venda':     _num(row.get('taxa_venda')),
                'desvio':         _num(row.get('desvio')),
                'pu':             _num(row.get('pu')),
                'duration':       _num(row.get('duration')),
                'data_ref':       data_ref,
            }

    return lookup


def parse_produtos(fb):
    """produtos-renda-fixa-*.xlsx -> list[dict]  (credit OR títulos públicos)"""
    xl = pd.ExcelFile(fb)
    if 'Resultado' not in xl.sheet_names:
        return []
    df = xl.parse('Resultado').dropna(subset=['Ativo'])
    want = {
        'Ativo':                    'ativo',
        'Ticker':                   'ticker',
        'Instrumento':              'instrumento',
        'Duration':                 'duration_xp',
        'Indexador':                'indexador',
        'Juros':                    'juros',           # coupon frequency
        'Primeira Data de Juros':   'primeira_data_juros',
        'Amortização':              'amortizacao',
        'Primeira Data de Amortização': 'primeira_data_amortizacao',
        'Isento':                   'isento',
        'Rating':                   'rating',
        'Risco':                    'risco',
        'Vencimento':               'vencimento',
        'Tax.Mín':                  'taxa_min',
        'Tax.Máx':                  'taxa_max',
        'Taxa de Emissão':          'taxa_emissao',
        'ROA E. Aprox.':            'roa',
        'Público':                  'publico',
        'Qtd Mín.':                 'qtd_min',
        'Carência':                 'carencia',
        'Data de Emissão':          'data_emissao',
    }
    rows = [{v: _safe(row[k]) for k, v in want.items() if k in df.columns}
            for _, row in df.iterrows()]
    # Normaliza Isento para 'S'/'N' (o XP exporta "Sim"/"Não" — sem este
    # passo o frontend renderiza '—' e os filtros Isento/NãoIsento quebram
    # nas abas IPCA+/CDI%/CDI+/PRE/TP).
    for r in rows:
        v = r.get('isento')
        if v is None or v == '':
            continue
        s = str(v).strip().lower()
        r['isento'] = 'S' if s in ('sim', 's', 'true', '1', 'isento') else 'N'
    return rows


def parse_empresas(fb):
    """Lista_Empresas_*.xlsx -> (list[dict], name_lookup_dict)"""
    xl = pd.ExcelFile(fb)
    if 'Empresas' not in xl.sheet_names:
        return [], {}
    df = xl.parse('Empresas').dropna(subset=['Empresa'])
    want = {
        'Empresa': 'empresa', 'Ticker': 'ticker', 'Setor': 'setor',
        'Score Total': 'score_total', 'Score Setor': 'score_setor',
        'Score Quantitativo': 'score_quant', 'Score Qualitativo': 'score_qual',
        'Alocação Máxima (%)': 'aloc_max',
        'Rating Fitch': 'rating_fitch', 'Rating S&P': 'rating_sp',
        "Rating Moody's": 'rating_moodys',
        'NET Total (R$)': 'net_total', 'NET Filtrado (R$)': 'net_filtrado',
        'Detentores Total': 'det_total', 'Detentores Filtrado': 'det_filtrado',
        'Última Revisão': 'ultima_revisao',
    }
    rows = [{v: _safe(row[k]) for k, v in want.items() if k in df.columns}
            for _, row in df.iterrows()]
    lookup = {_norm(r['empresa']): r for r in rows if r.get('empresa')}
    return rows, lookup


def parse_mercado(fb):
    """mercado CSV -> list[dict]  (BID/OFFER market data from XP).

    Tenta múltiplos encodings comuns (utf-8, latin-1, cp1252). Apenas erros
    de decodificação fazem fallback silencioso; qualquer outra exceção
    (arquivo corrompido, CSV malformado) é propagada para cima para aparecer
    como erro de upload em vez de ser mascarada como lista vazia."""
    df = None
    last_err = None
    for enc in ['utf-8', 'latin-1', 'cp1252']:
        try:
            fb.seek(0)
            df = pd.read_csv(fb, sep=';', encoding=enc)
            break
        except UnicodeDecodeError as e:
            last_err = e
            continue
    if df is None:
        raise ValueError(
            f"Não foi possível decodificar o CSV do Mercado com utf-8/latin-1/cp1252: {last_err}"
        )

    df.columns = [c.strip() for c in df.columns]

    TIPO_RE = re.compile(r'^(CRI|CRA|DEB|CDCA|LF|CDB)\s+(.+?)(?:\s*-\s*[A-Z]{3}/\d{4})?$')

    rows = []
    for _, row in df.iterrows():
        emissor_risco = str(row.get('Emissor / Risco', '')).strip()
        if not emissor_risco or emissor_risco == 'nan':
            continue

        # Extract tipo and emissor from "CRI ISSUER - MMM/YYYY"
        m = TIPO_RE.match(emissor_risco)
        tipo    = m.group(1) if m else ''
        emissor = m.group(2).strip() if m else emissor_risco

        # Parse Tax. Mín. / Tax. Máx.
        tax_str = str(row.get('Tax. Mín. / Tax. Máx.', '')).strip()
        parts = tax_str.split(' / ', 1)
        taxa_min_str = parts[0].strip() if len(parts) >= 1 else ''
        taxa_max_str = parts[1].strip() if len(parts) >= 2 else ''
        xp_type, xp_min = _parse_xp_rate(taxa_min_str)
        _,        xp_max = _parse_xp_rate(taxa_max_str)

        # Isento
        isento_raw = str(row.get('Isento', '')).strip()
        isento = 'S' if isento_raw.lower() == 'sim' else 'N'

        # Rating
        rating_raw = str(row.get('Rating', '')).strip()
        rating = None if rating_raw in ('-', '', 'nan') else rating_raw

        # BID / OFFER rates
        bid_raw = str(row.get('BID Mercado', '')).replace('%', '').strip()
        bid_rate = None if bid_raw in ('-', '', 'nan') else _num(bid_raw)

        offer_raw = str(row.get('OFFER Mercado', '')).replace('%', '').strip()
        offer_rate = None if offer_raw in ('-', '', 'nan') else _num(offer_raw)

        # Volumes and quantities
        vol_bid  = _num(row.get('Vol. BID'))
        qtd_bid  = _num(str(row.get('Qtd. BID', '')).replace('-', '').strip())
        vol_offer = _num(row.get('Vol. OFFER'))
        qtd_offer = _num(str(row.get('Qtd. OFFER', '')).replace('-', '').strip())

        # ROA — preferimos o valor vindo do arquivo XP. Se ausente, calculamos
        # um fallback numérico: ROA ≈ (taxa_max − taxa_min) × duration (anos).
        # Isso representa a receita anual retida pela XP no modo comissão.
        roa = str(row.get('ROA E. Aprox.', '')).strip()

        # Duration (already in years)
        duration = _num(row.get('Duration'))

        if (not roa or roa in ('-', 'nan')) \
                and xp_min is not None and xp_max is not None \
                and duration is not None:
            roa_num = round((xp_max - xp_min) * duration, 4)
            if roa_num > 0:
                # Formata no padrão usado pelo app.js (_parseRoa aceita "0,47%")
                roa = f"{roa_num:.2f}%".replace('.', ',')

        indexador_str = str(row.get('Indexador', '')).strip()
        rows.append({
            'emissor_risco': emissor_risco,
            'instrumento':   tipo,          # CRI/CRA/DEB/CDCA — matches app.js _instrBadge
            'emissor':       emissor,
            'duration':      duration,
            'indexador':     indexador_str,
            'indice_type':   _infer_type_from_indice(indexador_str),
            'juros':         str(row.get('Juros', '')).strip(),
            'amortizacao':   str(row.get('Amortização', '')).strip(),
            'isento':        isento,
            'rating':        rating,
            'risco':         str(row.get('Risco', '')).strip(),
            'vencimento':    str(row.get('Vencimento', '')).strip(),
            'ticker':        str(row.get('Ticker', '')).strip(),
            'vol_bid':       vol_bid,
            'qtd_bid':       qtd_bid,
            'bid_rate':      bid_rate,
            'bid_rate_str':  bid_raw + '%' if bid_rate else None,
            'offer_rate':    offer_rate,
            'offer_rate_str': offer_raw + '%' if offer_rate else None,
            'qtd_offer':     qtd_offer,
            'vol_offer':     vol_offer,
            # Standardised names matching _effectiveRate() in app.js
            'taxa_min':      taxa_min_str,   # commission rate (string)
            'taxa_max':      taxa_max_str,   # fee-based rate (string)
            'taxa_min_num':  xp_min,         # commission numeric spread
            'taxa_max_num':  xp_max,         # fee-based numeric spread
            'xp_type':       xp_type,
            'roa':           roa,
        })

    return rows


def compute_mercado_analysis():
    """Join mercado BID/OFFER data with ANBIMA rates + empresa scores + B3."""
    mercado    = store.get('mercado', [])
    anbima     = {**store.get('anbima_cri_cra', {}), **store.get('anbima_debentures', {})}
    emp_lookup = store.get('emp_lookup', {})
    b3_lookup  = compute_b3_lookup() if 'b3_negocios' in store else {}

    # Tracking de codigos B3 que casaram via mercado (para diagnostico)
    b3_matched = set()

    result = []
    for item in mercado:
        ticker = item.get('ticker', '').strip()
        ref    = anbima.get(ticker)

        anbima_taxa = ref.get('taxa_indicativa') if ref else None
        xp_min      = item.get('taxa_min_num')
        xp_max      = item.get('taxa_max_num')

        delta    = round(xp_min - anbima_taxa, 6) if xp_min    is not None and anbima_taxa is not None else None
        delta_fb = round(xp_max - anbima_taxa, 6) if xp_max    is not None and anbima_taxa is not None else None

        offer = item.get('offer_rate')
        bid   = item.get('bid_rate')
        delta_mkt_xp    = round(offer - xp_min, 4) if offer is not None and xp_min is not None else None
        delta_mkt_xp_fb = round(offer - xp_max, 4) if offer is not None and xp_max is not None else None
        delta_bid_xp    = round(bid   - xp_min, 4) if bid   is not None and xp_min is not None else None

        # OFFER/BID XP (book proprio XP) vs Indicativa ANBIMA
        delta_offer_anbima = round(offer - anbima_taxa, 4) if offer is not None and anbima_taxa is not None else None
        delta_bid_anbima   = round(bid   - anbima_taxa, 4) if bid   is not None and anbima_taxa is not None else None
        spread_bid_ask_xp  = round(offer - bid, 4) if offer is not None and bid is not None else None

        # Taxas ANBIMA Compra/Venda - propagadas para validacao fair-value
        anb_compra  = ref.get('taxa_compra') if ref else None
        anb_venda   = ref.get('taxa_venda')  if ref else None
        anb_spread_ba = (round(anb_venda - anb_compra, 4)
                         if anb_compra is not None and anb_venda is not None else None)

        emp = _find_score(item.get('emissor', ''), emp_lookup)
        b3  = _b3_match(b3_lookup, ticker)
        if b3 and b3.get('cod_if'):
            b3_matched.add(b3['cod_if'])

        coupon_sched = _coupon_schedule(item)

        result.append({
            **item,
            'coupon_schedule': coupon_sched,
            'next_event':      coupon_sched[0] if coupon_sched else None,
            'anbima':           anbima_taxa,
            'anbima_compra':    anb_compra,
            'anbima_venda':     anb_venda,
            'anbima_spread_ba': anb_spread_ba,
            'pu':               ref.get('pu')  if ref else None,
            'delta_anbima':     delta,
            'delta_anbima_fb':  delta_fb,
            'delta_mkt_xp':     delta_mkt_xp,
            'delta_mkt_xp_fb':  delta_mkt_xp_fb,
            'delta_bid_xp':     delta_bid_xp,
            'delta_offer_anbima': delta_offer_anbima,
            'delta_bid_anbima':   delta_bid_anbima,
            'spread_bid_ask_xp':  spread_bid_ask_xp,
            'score_total':      emp.get('score_total')  if emp else None,
            'score_quant':      emp.get('score_quant')  if emp else None,
            'score_qual':       emp.get('score_qual')   if emp else None,
            'aloc_max':         emp.get('aloc_max')     if emp else None,
            'setor':            emp.get('setor')        if emp else None,
            'b3_vol_total':     b3.get('vol_total')   if b3 else None,
            'b3_vol_extra':     b3.get('vol_extra')   if b3 else None,
            'b3_n_trades':      b3.get('n_trades')    if b3 else None,
            'b3_pu_medio':      b3.get('pu_medio')    if b3 else None,
            'b3_ratio_extra':   b3.get('ratio_extra') if b3 else None,
            'b3_oscilacao':     b3.get('oscilacao')   if b3 else None,
            'b3_dias_negociados': b3.get('dias_negociados') if b3 else None,
            'b3_last_date':     b3.get('last_date')   if b3 else None,
            'b3_vol_intra_pct':     b3.get('vol_intra_pct')     if b3 else None,
            'b3_vol_diaria_std':    b3.get('vol_diaria_std')    if b3 else None,
            'b3_vol_period_pct':    b3.get('vol_period_pct')    if b3 else None,
            'b3_tendencia_pct_dia': b3.get('tendencia_pct_dia') if b3 else None,
            'b3_persistencia':      b3.get('persistencia')      if b3 else None,
            'b3_n_obs':             b3.get('n_obs')             if b3 else None,
        })

    g.store.setdefault('_b3_diag', {})['matched_via_mercado'] = b3_matched

    return sorted(result, key=lambda r: (r['delta_anbima'] is None, -(r['delta_anbima'] or 0)))


def compute_oportunidades():
    """Cross-reference RF Mercado OFFER rates with the XP credit catalog (spread_score).

    For each asset that has an active OFFER in the mercado AND exists in the XP
    product catalog, compute the delta between what the market offers and what
    XP's catalog offers.  Positive delta = buying in the secondary market gives
    the investor a HIGHER rate (i.e. cheaper price) than buying through XP.
    """
    analysis = store.get('analysis') or {}
    mercado  = store.get('mercado_analysis', [])
    if not mercado:
        return []

    # Build catalog lookup: ticker -> enriched row from spread_score
    catalog: dict = {}
    for bucket in ('ipca', 'cdi_pct', 'cdi_plus', 'pre', 'outros'):
        for row in analysis.get(bucket, []):
            t = str(row.get('ticker', '')).strip()
            if t:
                catalog[t] = row

    results = []
    for mkt in mercado:
        ticker    = str(mkt.get('ticker', '')).strip()
        offer     = mkt.get('offer_rate')
        vol_offer = mkt.get('vol_offer') or 0

        # Only include rows with an active OFFER order
        if offer is None or vol_offer <= 0:
            continue

        cat = catalog.get(ticker)
        if not cat:
            continue  # not in XP catalog — no comparison possible

        # NB: apesar do nome "spread_xp" no catálogo, o valor é a TAXA numérica
        # absoluta oferecida pela XP (ex.: 6.30 para IPCA+6,30%). Não é um
        # spread relativo a nenhuma referência. Renomeamos aqui para refletir
        # a semântica real: cat_taxa_num (comissão) / cat_taxa_num_fb (fee-based).
        cat_taxa_num    = cat.get('spread_xp')
        cat_taxa_num_fb = cat.get('spread_xp_fb')

        delta_com = round(offer - cat_taxa_num,    4) if cat_taxa_num    is not None else None
        delta_fb  = round(offer - cat_taxa_num_fb, 4) if cat_taxa_num_fb is not None else None

        results.append({
            # Identity
            'ticker':       ticker,
            'instrumento':  mkt.get('instrumento'),
            'emissor':      mkt.get('emissor'),
            'vencimento':   mkt.get('vencimento'),
            'duration':     mkt.get('duration'),
            'indexador':    mkt.get('indexador'),
            'indice_type':  mkt.get('indice_type'),
            'isento':       mkt.get('isento'),
            'rating':       mkt.get('rating'),
            'setor':        mkt.get('setor'),
            'score_total':  mkt.get('score_total'),
            # Mercado data
            'offer_rate':     offer,
            'offer_rate_str': mkt.get('offer_rate_str'),
            'vol_offer':      vol_offer,
            'bid_rate':       mkt.get('bid_rate'),
            'bid_rate_str':   mkt.get('bid_rate_str'),
            'vol_bid':        mkt.get('vol_bid'),
            'anbima':         mkt.get('anbima'),
            'delta_anbima_mkt': mkt.get('delta_anbima'),
            # XP catalog data
            'cat_taxa_xp':     cat.get('taxa_xp'),
            'cat_taxa_fb':     cat.get('taxa_xp_fb'),
            'cat_taxa_num':    cat_taxa_num,
            'cat_taxa_num_fb': cat_taxa_num_fb,
            'cat_delta_anbima': cat.get('delta_anbima'),
            'cat_pu':          cat.get('pu'),
            'cat_roa':         cat.get('roa'),
            # Key comparison
            'delta_vs_catalog':    delta_com,  # + = mercado melhor para compra
            'delta_vs_catalog_fb': delta_fb,
            # Indicação / alocação do catálogo (aloc_max é a única fonte da verdade)
            'aloc_max':     cat.get('aloc_max'),
            # Campos do catálogo XP úteis para filtros compartilhados com a RF Mercado
            'publico':      cat.get('publico'),
            'juros':        cat.get('juros'),
            'amortizacao':  cat.get('amortizacao'),
            # Premio de risco (vs curva soberana) - vem do catalogo
            'premio_risco':    cat.get('premio_risco'),
            'premio_risco_fb': cat.get('premio_risco_fb'),
            'curva_ref_taxa':  cat.get('curva_ref_taxa'),
            # B3 - propaga do mercado_analysis enriquecido
            'b3_vol_total':       mkt.get('b3_vol_total'),
            'b3_vol_extra':       mkt.get('b3_vol_extra'),
            'b3_n_trades':        mkt.get('b3_n_trades'),
            'b3_pu_medio':        mkt.get('b3_pu_medio'),
            'b3_ratio_extra':     mkt.get('b3_ratio_extra'),
            'b3_oscilacao':       mkt.get('b3_oscilacao'),
            'b3_dias_negociados': mkt.get('b3_dias_negociados'),
            'b3_last_date':       mkt.get('b3_last_date'),
            'b3_vol_intra_pct':     mkt.get('b3_vol_intra_pct'),
            'b3_vol_diaria_std':    mkt.get('b3_vol_diaria_std'),
            'b3_vol_period_pct':    mkt.get('b3_vol_period_pct'),
            'b3_tendencia_pct_dia': mkt.get('b3_tendencia_pct_dia'),
            'b3_persistencia':      mkt.get('b3_persistencia'),
            'b3_n_obs':             mkt.get('b3_n_obs'),
            # Cronograma
            'coupon_schedule': mkt.get('coupon_schedule'),
            'next_event':      mkt.get('next_event'),
        })

    return sorted(results,
                  key=lambda r: (r['delta_vs_catalog'] is None, -(r['delta_vs_catalog'] or 0)))


_FIND_SCORE_MIN_LEN = 3  # nomes ≤3 letras (MRV, RGE) só casam por palavra inteira


def _find_score(anbima_name, emp_lookup):
    """Fuzzy-match an ANBIMA issuer name against the empresa lookup.

    Heurística:
      1. Match exato ganha sempre.
      2. Para nomes curtos (≤3 letras, ex: 'MRV'), exigimos match de palavra
         inteira (boundary), evitando 'MRV' bater em 'MRVPRO' espuriamente.
      3. Para nomes ≥4 letras, basta ser substring (mais flexível).
      4. Em empate de comprimento, preferimos o candidato cujo nome é mais
         próximo em tamanho do nome da ANBIMA (menor diferença absoluta),
         mitigando o caso holding-vs-subsidiária."""
    if not anbima_name or not emp_lookup:
        return None
    norm_a = _norm(anbima_name)
    if not norm_a:
        return None

    # Match exato
    if norm_a in emp_lookup:
        return emp_lookup[norm_a]

    # Pré-tokeniza norm_a uma vez (palavras separadas por espaço) para o
    # match de "palavra inteira" usado quando o emissor tem ≤ 3 letras.
    a_words = set(norm_a.split())

    best = None
    best_len = 0
    best_size_diff = 10 ** 9
    for emp_norm, emp_data in emp_lookup.items():
        if not emp_norm or len(emp_norm) < _FIND_SCORE_MIN_LEN:
            continue
        # Match strategy: nomes curtos exigem palavra inteira; longos aceitam substring.
        is_short = len(emp_norm) <= 3
        if is_short:
            # Token-level match: 'MRV' ∈ {'MRV', 'ENGENHARIA'}? sim
            e_words = set(emp_norm.split())
            matches = bool(e_words & a_words)
        else:
            matches = (emp_norm in norm_a) or (norm_a in emp_norm)
        if matches:
            match_len = min(len(emp_norm), len(norm_a))
            size_diff = abs(len(emp_norm) - len(norm_a))
            if match_len > best_len or (
                match_len == best_len and size_diff < best_size_diff
            ):
                best_len = match_len
                best_size_diff = size_diff
                best = emp_data
    return best


# ── CRONOGRAMA DE EVENTOS (JUROS + AMORTIZACAO) ─────────────────────────────

_FREQ_MONTHS = {
    'MENSAL':      1,
    'TRIMESTRAL':  3,
    'SEMESTRAL':   6,
    'ANUAL':       12,
}


def _norm_freq(s):
    """Normaliza 'Semestral' -> 'SEMESTRAL'. None se Vencimento ou desconhecido."""
    if not s: return None
    u = str(s).strip().upper()
    return u if u in _FREQ_MONTHS else None


def _parse_br_date(s):
    """'06/04/2026' ou '06/04/26' -> (yyyy, mm, dd)."""
    if not s: return None
    parts = str(s).strip().split('/')
    if len(parts) != 3: return None
    try:
        d, m, y = int(parts[0]), int(parts[1]), int(parts[2])
        if y < 100: y += 2000
        return (y, m, d)
    except (ValueError, TypeError):
        return None


def _parse_date_any(v):
    """Aceita Timestamp, 'dd/mm/yyyy', 'dd/mm/yy', 'yyyy-mm-dd' -> datetime.date."""
    import datetime as _dt
    if v is None or v == '' or (isinstance(v, float) and (v != v)): return None
    if isinstance(v, pd.Timestamp):
        return v.date()
    if hasattr(v, 'date') and callable(getattr(v, 'date', None)):
        try: return v.date()
        except Exception: pass
    s = str(v).strip()
    if not s: return None
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', s)
    if m:
        try: return _dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError: return None
    m = re.match(r'(\d{1,2})/(\d{1,2})/(\d{2,4})', s)
    if m:
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if y < 100: y += 2000
        try: return _dt.date(y, mo, d)
        except ValueError: return None
    return None


def _add_months(d, n):
    """Adiciona n meses preservando o dia (clipping no fim do mes)."""
    import datetime as _dt
    if d is None or n is None: return None
    total = d.month - 1 + n
    y = d.year + total // 12
    mo = total % 12 + 1
    import calendar
    last_day = calendar.monthrange(y, mo)[1]
    day = min(d.day, last_day)
    return _dt.date(y, mo, day)


def _coupon_schedule(row, today=None, max_events=60, past_window_days=0):
    """Constroi cronograma de eventos futuros (juros + amortizacao) para um papel.

    Estrategia:
      - Se tem `primeira_data_juros` (catalogo XP) -> forward (a partir dela)
      - Senao -> backward a partir do vencimento (mercado XP)
    Analogo para amortizacao.

    Args:
      past_window_days: 0 (default) devolve so >= today. N > 0 inclui ate N dias
        no passado (necessario p/ vol_ex_cupom em series historicas B3).
    """
    import datetime as _dt
    today = today or _dt.date.today()
    venc = _parse_date_any(row.get('vencimento'))
    if not venc:
        return []

    juros_freq = _norm_freq(row.get('juros'))
    amort_freq = _norm_freq(row.get('amortizacao'))
    primeira_j = _parse_date_any(row.get('primeira_data_juros'))
    primeira_a = _parse_date_any(row.get('primeira_data_amortizacao'))

    earliest_keep = today - _dt.timedelta(days=past_window_days)

    def _build_series(freq_months, first, end, source):
        out = []
        if freq_months is None or freq_months <= 0:
            return out
        if first is not None:
            d = first
            while d <= end and len(out) < max_events:
                out.append((d, source))
                d = _add_months(d, freq_months)
        else:
            d = end
            while d >= earliest_keep and len(out) < max_events:
                out.append((d, source))
                d = _add_months(d, -freq_months)
        return out

    j_months = _FREQ_MONTHS.get(juros_freq) if juros_freq else None
    j_series = _build_series(j_months, primeira_j, venc,
                              'forward' if primeira_j else 'backward')
    a_months = _FREQ_MONTHS.get(amort_freq) if amort_freq else None
    a_series = _build_series(a_months, primeira_a, venc,
                              'forward' if primeira_a else 'backward')

    ev = {}
    for d, src in j_series:
        ev.setdefault(d, {'tipo': set(), 'source': src})['tipo'].add('juros')
    for d, src in a_series:
        rec = ev.setdefault(d, {'tipo': set(), 'source': src})
        rec['tipo'].add('amort')
        if src == 'forward': rec['source'] = 'forward'

    if not j_series and not a_series:
        if venc >= today:
            ev[venc] = {'tipo': {'amort','juros'}, 'source': 'maturity'}

    out = []
    for d in sorted(ev.keys()):
        if d < earliest_keep:
            continue
        tipos = ev[d]['tipo']
        tipo = 'ambos' if ('juros' in tipos and 'amort' in tipos) else (
            'juros' if 'juros' in tipos else 'amort')
        out.append({
            'date':     d.strftime('%d/%m/%Y'),
            'date_iso': d.strftime('%Y-%m-%d'),
            'tipo':     tipo,
            'source':   ev[d]['source'],
            'months_to_vcto': (venc.year - d.year) * 12 + (venc.month - d.month),
            'days_from_today': (d - today).days,
        })
        if len(out) >= max_events:
            break
    return out


# ── VOLATILITY METRICS (com ex-cupom) ───────────────────────────────────────

def _compute_volatility_metrics(series, coupon_dates=None):
    """Recebe lista [(date_tuple, pu_medio, vol_dia, pu_min, pu_max, oscil, n_trades)]
    ordenada por data e calcula metricas de volatilidade."""
    pus = [s[1] for s in series if s[1] is not None and s[1] > 0]
    if not pus:
        return {'vol_intra_pct': None, 'vol_diaria_std': None,
                'vol_diaria_std_ex_cupom': None, 'n_excluded_cupom': 0,
                'vol_period_pct': None, 'tendencia_pct_dia': None, 'n_obs': 0}

    intra_vals = []
    for _, pu_med, _vol, pu_min, pu_max, _osc, _n in series:
        if pu_med and pu_med > 0 and pu_min is not None and pu_max is not None:
            intra_vals.append((pu_max - pu_min) / pu_med * 100.0)
    vol_intra = sum(intra_vals) / len(intra_vals) if intra_vals else None

    pu_serie = [(d, pu) for (d, pu, *_rest) in series if pu is not None and pu > 0]
    pu_serie.sort(key=lambda x: x[0])
    rets = []
    for i in range(1, len(pu_serie)):
        p0, p1 = pu_serie[i-1][1], pu_serie[i][1]
        if p0 > 0:
            rets.append((p1/p0 - 1.0) * 100.0)
    if len(rets) >= 2:
        mean_r = sum(rets) / len(rets)
        var = sum((r-mean_r)**2 for r in rets) / (len(rets) - 1)
        vol_diaria = var ** 0.5
    elif len(rets) == 1:
        vol_diaria = abs(rets[0])
    else:
        vol_diaria = None

    mins_dias = [s[3] for s in series if s[3] is not None and s[3] > 0]
    maxs_dias = [s[4] for s in series if s[4] is not None and s[4] > 0]
    pu_min_g = min(mins_dias) if mins_dias else min(pus)
    pu_max_g = max(maxs_dias) if maxs_dias else max(pus)
    pu_med_g = sum(pus) / len(pus)
    vol_period = (pu_max_g - pu_min_g) / pu_med_g * 100.0 if pu_med_g > 0 else None

    if len(pu_serie) >= 2:
        n = len(pu_serie)
        xs = list(range(n))
        ys = [p[1] for p in pu_serie]
        mx = sum(xs) / n; my = sum(ys) / n
        num = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
        den = sum((x-mx)**2 for x in xs)
        slope = num / den if den > 0 else 0
        tendencia = (slope / my * 100.0) if my > 0 else None
    else:
        tendencia = None

    vol_diaria_ex = None
    n_excluded = 0
    if coupon_dates and len(rets) >= 2:
        import datetime as _dt
        coupon_set = set()
        for cd in coupon_dates:
            try:
                base = _dt.date(*cd)
            except Exception:
                continue
            for off in range(-2, 5):
                coupon_set.add(base + _dt.timedelta(days=off))
        rets_ex = []
        for i in range(1, len(pu_serie)):
            d_curr = _dt.date(*pu_serie[i][0])
            if d_curr in coupon_set:
                n_excluded += 1
                continue
            p0, p1 = pu_serie[i-1][1], pu_serie[i][1]
            if p0 > 0:
                rets_ex.append((p1/p0 - 1.0) * 100.0)
        if len(rets_ex) >= 2:
            mean_r = sum(rets_ex) / len(rets_ex)
            var = sum((r-mean_r)**2 for r in rets_ex) / (len(rets_ex) - 1)
            vol_diaria_ex = var ** 0.5

    return {
        'vol_intra_pct':         round(vol_intra,  4) if vol_intra  is not None else None,
        'vol_diaria_std':        round(vol_diaria, 4) if vol_diaria is not None else None,
        'vol_diaria_std_ex_cupom': round(vol_diaria_ex, 4) if vol_diaria_ex is not None else None,
        'n_excluded_cupom':      n_excluded,
        'vol_period_pct':        round(vol_period, 4) if vol_period is not None else None,
        'tendencia_pct_dia':     round(tendencia,  4) if tendencia  is not None else None,
        'n_obs':                 len(pu_serie),
    }


# ── B3 NEGOCIOS (mercado secundario oficial) ────────────────────────────────

def parse_b3_negocios(fb, filename=''):
    """Parser do CSV B3 'Negocios Realizados - Mercado Secundario'.
    Agrega por (cod_if, data) preservando INTRAGRUPO/EXTRAGRUPO p/ ratio extra.
    """
    fname = (filename or '').lower()
    df = None
    if fname.endswith('.xlsx') or fname.endswith('.xls'):
        df = pd.read_excel(fb)
    else:
        last_err = None

        def _find_header_row(raw_text, max_scan=30):
            for i, line in enumerate(raw_text.splitlines()[:max_scan]):
                low = line.lower()
                if ('data negocio' in low or 'data negócio' in low) and ('codigo if' in low or 'código if' in low):
                    return i
            return 0

        for enc in ['utf-8-sig', 'utf-8', 'latin-1', 'cp1252']:
            try:
                fb.seek(0)
                head_bytes = fb.read(8192)
                fb.seek(0)
                head_text = head_bytes.decode(enc, errors='replace')
                skip = _find_header_row(head_text)
                for sep in [';', '\t', ',']:
                    try:
                        fb.seek(0)
                        df = pd.read_csv(fb, sep=sep, encoding=enc, skiprows=skip, low_memory=False)
                        if df.shape[1] >= 8:
                            break
                        df = None
                    except UnicodeDecodeError as e:
                        last_err = e
                    except Exception as e:
                        last_err = e
                if df is not None and df.shape[1] >= 8:
                    break
            except UnicodeDecodeError as e:
                last_err = e
                continue
        if df is None:
            raise ValueError(f"Nao foi possivel ler o CSV B3: {last_err}")

    df.columns = [str(c).strip().lstrip('﻿') for c in df.columns]

    def _col(*candidates):
        for c in candidates:
            for actual in df.columns:
                if c.lower() == actual.lower(): return actual
        for c in candidates:
            for actual in df.columns:
                if c.lower() in actual.lower(): return actual
        return None

    C = {
        'data':       _col('Data negócio', 'Data do negócio', 'Data Negócio'),
        'cod_if':     _col('Código IF', 'Codigo IF'),
        'instr':      _col('Instrumento financeiro', 'Instrumento'),
        'isin':       _col('Código ISIN', 'ISIN'),
        'emissor':    _col('Emissor'),
        'qtd':        _col('Quantidade negociada', 'Quantidade'),
        'p_min':      _col('Preço mínimo', 'Preco minimo'),
        'p_med':      _col('Preço médio', 'Preco medio'),
        'p_max':      _col('Preço máximo', 'Preco maximo'),
        'p_ult':      _col('Último preço', 'Ultimo preco'),
        'p_ref':      _col('Preço de referência', 'Preco de referencia'),
        'n_negocios': _col('Número de negócios', 'Numero de negocios', 'Negócios'),
        'vol_fin':    _col('Volume financeiro (R$)', 'Volume financeiro', 'Volume'),
        'classif':    _col('Classificação do negócio', 'Classificacao'),
        'oscil':      _col('Oscilação', 'Oscilacao'),
    }
    if not C['cod_if'] or not C['vol_fin']:
        raise ValueError(f"Cabecalho B3 invalido: {list(df.columns)[:10]}")

    df = df.rename(columns={
        C['data']:'data', C['cod_if']:'cod_if', C['instr']:'instr',
        C['isin']:'isin', C['emissor']:'emissor',
        C['qtd']:'qtd', C['p_min']:'p_min', C['p_med']:'p_med',
        C['p_max']:'p_max', C['p_ult']:'p_ult', C['p_ref']:'p_ref',
        C['n_negocios']:'n_neg', C['vol_fin']:'vol_fin',
        C['classif']:'classif', C['oscil']:'oscil',
    })
    df = df.loc[:, ~df.columns.duplicated()]

    df['cod_if'] = df['cod_if'].astype(str).str.strip()
    df = df[df['cod_if'].str.lower().ne('nan') & df['cod_if'].ne('')]

    def _to_num_series(s):
        if s.dtype.kind in 'fi':
            return pd.to_numeric(s, errors='coerce')
        s = s.astype(str).str.strip()
        has_comma = s.str.contains(',', regex=False, na=False)
        has_dot   = s.str.contains('.',  regex=False, na=False)
        m1 = has_comma & has_dot
        s.loc[m1] = s.loc[m1].str.replace('.', '', regex=False).str.replace(',', '.', regex=False)
        m2 = has_comma & ~has_dot
        s.loc[m2] = s.loc[m2].str.replace(',', '.', regex=False)
        n_dots = s.str.count(r'\.')
        m3 = ~has_comma & (n_dots >= 2)
        s.loc[m3] = s.loc[m3].str.replace('.', '', regex=False)
        s = s.replace({'-': None, '': None, 'nan': None, 'NaN': None, 'N/D': None, 'None': None})
        return pd.to_numeric(s, errors='coerce')

    for col in ['qtd','p_min','p_med','p_max','p_ult','p_ref','n_neg','vol_fin','oscil']:
        if col in df.columns:
            df[col] = _to_num_series(df[col])

    df['n_neg'] = df['n_neg'].fillna(0).astype('int64')
    n_reg_filtered = int((df['n_neg'] == 0).sum())
    df = df[df['n_neg'] > 0]

    df['data']    = df['data'].astype(str).str.strip()
    df['instr']   = df['instr'].fillna('').astype(str).str.strip() if 'instr' in df.columns else ''
    df['emissor'] = df['emissor'].fillna('').astype(str).str.strip() if 'emissor' in df.columns else ''
    if 'isin' in df.columns:
        df['isin'] = df['isin'].astype(str).str.strip()
        df.loc[df['isin'].isin(['-','nan','','None']), 'isin'] = None
    df['classif'] = (df['classif'].fillna('-').astype(str).str.strip().str.upper()
                                  .replace({'-':'MERCADO','':'MERCADO','NAN':'MERCADO'}))
    df['_pu_x_vol'] = df['p_med'].fillna(0) * df['vol_fin'].fillna(0)

    g_keys = ['cod_if', 'data']
    base = df.groupby(g_keys, as_index=False).agg(
        instr=('instr', 'first'),
        emissor=('emissor', 'first'),
        isin=('isin', lambda s: next((x for x in s if x), None)),
        qtd_total=('qtd', 'sum'),
        vol_total=('vol_fin', 'sum'),
        _sum_pu_x_vol=('_pu_x_vol', 'sum'),
        n_trades=('n_neg', 'sum'),
        pu_min=('p_min', 'min'),
        pu_max=('p_max', 'max'),
        pu_ult=('p_ult', 'last'),
        pu_ref=('p_ref', 'last'),
        oscilacao=('oscil', 'last'),
    )
    piv_vol = df.pivot_table(index=g_keys, columns='classif', values='vol_fin',
                             aggfunc='sum', fill_value=0).reset_index()
    piv_n   = df.pivot_table(index=g_keys, columns='classif', values='n_neg',
                             aggfunc='sum', fill_value=0).reset_index()
    piv_pu = df.pivot_table(index=g_keys, columns='classif', values='_pu_x_vol',
                            aggfunc='sum', fill_value=0).reset_index()

    out_df = base.merge(piv_vol, on=g_keys, how='left', suffixes=('','_v'))
    out_df = out_df.merge(piv_n,   on=g_keys, how='left', suffixes=('','_n'))
    out_df = out_df.merge(piv_pu,  on=g_keys, how='left', suffixes=('','_p'))

    def _safe_col(d, name, default=0):
        return d[name] if name in d.columns else default
    out_df['vol_intra']   = _safe_col(out_df, 'INTRAGRUPO',   0)
    out_df['vol_extra']   = _safe_col(out_df, 'EXTRAGRUPO',   0)
    out_df['vol_mercado'] = _safe_col(out_df, 'MERCADO',      0)
    out_df['n_intra']     = _safe_col(out_df, 'INTRAGRUPO_n', 0)
    out_df['n_extra']     = _safe_col(out_df, 'EXTRAGRUPO_n', 0)
    sum_pu_intra          = _safe_col(out_df, 'INTRAGRUPO_p', 0)
    sum_pu_extra          = _safe_col(out_df, 'EXTRAGRUPO_p', 0)

    vt = out_df['vol_total'].astype(float)
    out_df['pu_medio']       = (out_df['_sum_pu_x_vol'] / vt).where(vt > 0)
    vi = out_df['vol_intra'].astype(float)
    ve = out_df['vol_extra'].astype(float)
    out_df['pu_medio_intra'] = (sum_pu_intra / vi).where(vi > 0)
    out_df['pu_medio_extra'] = (sum_pu_extra / ve).where(ve > 0)
    out_df['ratio_extra']    = (ve / vt).where(vt > 0)

    for c in ['vol_total','vol_intra','vol_extra','vol_mercado']:
        out_df[c] = out_df[c].round(2)
    for c in ['pu_medio','pu_medio_intra','pu_medio_extra','pu_min','pu_max','pu_ult','pu_ref','ratio_extra']:
        out_df[c] = out_df[c].round(6) if c.startswith('pu_') else out_df[c].round(4)
    out_df['n_intra'] = out_df['n_intra'].astype('int64')
    out_df['n_extra'] = out_df['n_extra'].astype('int64')
    out_df['n_trades']= out_df['n_trades'].astype('int64')
    out_df['qtd_total'] = out_df['qtd_total'].fillna(0).round(4)

    out_df = out_df.sort_values('vol_total', ascending=False, kind='stable')

    cols_keep = ['data','cod_if','instr','isin','emissor','qtd_total',
                 'vol_intra','vol_extra','vol_mercado','vol_total',
                 'n_intra','n_extra','n_trades',
                 'pu_medio','pu_medio_intra','pu_medio_extra',
                 'pu_min','pu_max','pu_ult','pu_ref','oscilacao','ratio_extra']
    for c in cols_keep:
        if c not in out_df.columns: out_df[c] = None

    out_df = out_df[cols_keep].astype(object).where(out_df[cols_keep].notna(), None)
    return out_df.to_dict(orient='records')


def compute_b3_lookup():
    """Indexa b3_negocios por cod_if e ISIN. Adiciona series temporal +
    metricas de volatilidade (com vol_diaria_ex_cupom quando schedule disponivel)."""
    rows = store.get('b3_negocios', [])
    if not rows:
        return {}

    PAST_WINDOW_DAYS = 400
    coupon_by_ticker = {}
    for src in ('mercado_analysis', 'analysis'):
        src_data = store.get(src) or {}
        if isinstance(src_data, dict):
            for bucket in ('ipca','cdi_pct','cdi_plus','pre','outros'):
                for r in src_data.get(bucket, []) or []:
                    tk = (r.get('ticker') or '').strip()
                    if not tk: continue
                    sched = _coupon_schedule(r, past_window_days=PAST_WINDOW_DAYS)
                    if sched:
                        coupon_by_ticker.setdefault(tk, []).extend(
                            tuple(int(p) for p in e['date_iso'].split('-'))
                            for e in sched if e.get('date_iso'))
        elif isinstance(src_data, list):
            for r in src_data:
                tk = (r.get('ticker') or '').strip()
                if not tk: continue
                sched = _coupon_schedule(r, past_window_days=PAST_WINDOW_DAYS)
                if sched:
                    coupon_by_ticker.setdefault(tk, []).extend(
                        tuple(int(p) for p in e['date_iso'].split('-'))
                        for e in sched if e.get('date_iso'))

    from collections import defaultdict
    agg = defaultdict(lambda: {
        'cod_if': '', 'isin': None, 'instr': '', 'emissor': '',
        'vol_total': 0.0, 'vol_extra': 0.0, 'vol_intra': 0.0, 'vol_mercado': 0.0,
        'n_trades': 0, '_sum_pu_x_vol': 0.0,
        'pu_min': None, 'pu_max': None, 'pu_ult': None, 'pu_ref': None,
        'oscil_last': None, 'last_date': '',
        'series': [],
    })
    for r in rows:
        k = r['cod_if']
        a = agg[k]
        a['cod_if'] = k
        if r.get('isin'):    a['isin']    = r['isin']
        if r.get('instr'):   a['instr']   = r['instr']
        if r.get('emissor'): a['emissor'] = r['emissor']
        v = r.get('vol_total') or 0
        a['vol_total']   += v
        a['vol_extra']   += r.get('vol_extra')   or 0
        a['vol_intra']   += r.get('vol_intra')   or 0
        a['vol_mercado'] += r.get('vol_mercado') or 0
        a['n_trades']    += int(r.get('n_trades') or 0)
        if r.get('pu_medio') is not None and v:
            a['_sum_pu_x_vol'] += r['pu_medio'] * v
        if r.get('pu_min') is not None: a['pu_min'] = r['pu_min'] if a['pu_min'] is None else min(a['pu_min'], r['pu_min'])
        if r.get('pu_max') is not None: a['pu_max'] = r['pu_max'] if a['pu_max'] is None else max(a['pu_max'], r['pu_max'])
        if r.get('pu_ult') is not None: a['pu_ult'] = r['pu_ult']
        if r.get('pu_ref') is not None: a['pu_ref'] = r['pu_ref']
        if r.get('oscilacao') is not None: a['oscil_last'] = r['oscilacao']
        if (r.get('data') or '') > a['last_date']: a['last_date'] = r.get('data') or ''
        dt = _parse_br_date(r.get('data'))
        if dt is not None:
            a['series'].append((dt, r.get('pu_medio'), r.get('vol_total') or 0,
                                r.get('pu_min'), r.get('pu_max'),
                                r.get('oscilacao'), int(r.get('n_trades') or 0),
                                r.get('data')))

    all_dates = sorted({s[0] for a in agg.values() for s in a['series'] if s[0]})
    n_dates_total = len(all_dates) if all_dates else 0

    out_by_cod = {}
    out_by_isin = {}
    for k, a in agg.items():
        vt = a['vol_total']
        from collections import defaultdict as _dd
        per_day = _dd(lambda: {'vol':0.0, '_pu_x_vol':0.0, 'pu_min':None,
                                'pu_max':None, 'oscil':None, 'n_tr':0, 'data_str':''})
        for dt, pu_med, vol_dia, pu_min, pu_max, oscil, n_tr, ds in a['series']:
            d = per_day[dt]
            d['vol']       += vol_dia or 0
            if pu_med is not None and vol_dia:
                d['_pu_x_vol'] += pu_med * vol_dia
            if pu_min is not None: d['pu_min'] = pu_min if d['pu_min'] is None else min(d['pu_min'], pu_min)
            if pu_max is not None: d['pu_max'] = pu_max if d['pu_max'] is None else max(d['pu_max'], pu_max)
            if oscil is not None:  d['oscil']  = oscil
            d['n_tr']      += n_tr
            d['data_str']  = ds
        clean_series = []
        for dt in sorted(per_day.keys()):
            x = per_day[dt]
            pu = (x['_pu_x_vol'] / x['vol']) if x['vol'] else None
            clean_series.append((dt, pu, x['vol'], x['pu_min'], x['pu_max'],
                                  x['oscil'], x['n_tr']))

        cupon_dts = set(coupon_by_ticker.get(k, []))
        vol_metrics = _compute_volatility_metrics(clean_series, coupon_dates=cupon_dts)
        dias_negociados = len(clean_series)
        persistencia = (dias_negociados / n_dates_total) if n_dates_total else None

        series_payload = []
        for (dt, pu, v, mi, mx, osc, ntr) in clean_series:
            ds = per_day[dt].get('data_str', '')
            series_payload.append({
                'data':      ds,
                'pu_medio':  round(pu, 6) if pu is not None else None,
                'vol_total': round(v, 2) if v else 0,
                'pu_min':    mi, 'pu_max': mx, 'oscilacao': osc,
                'n_trades':  int(ntr or 0),
            })

        d = {
            'cod_if':       a['cod_if'],
            'isin':         a['isin'],
            'instr':        a['instr'],
            'emissor':      a['emissor'],
            'vol_total':    round(vt, 2),
            'vol_extra':    round(a['vol_extra'], 2),
            'vol_intra':    round(a['vol_intra'], 2),
            'vol_mercado':  round(a['vol_mercado'], 2),
            'n_trades':     a['n_trades'],
            'pu_medio':     round(a['_sum_pu_x_vol'] / vt, 6) if vt else None,
            'pu_min':       a['pu_min'],
            'pu_max':       a['pu_max'],
            'pu_ult':       a['pu_ult'],
            'pu_ref':       a['pu_ref'],
            'oscilacao':    a['oscil_last'],
            'ratio_extra':  round(a['vol_extra'] / vt, 4) if vt else None,
            'dias_negociados': dias_negociados,
            'last_date':    a['last_date'],
            'vol_intra_pct':           vol_metrics['vol_intra_pct'],
            'vol_diaria_std':          vol_metrics['vol_diaria_std'],
            'vol_diaria_std_ex_cupom': vol_metrics.get('vol_diaria_std_ex_cupom'),
            'n_excluded_cupom':        vol_metrics.get('n_excluded_cupom', 0),
            'vol_period_pct':          vol_metrics['vol_period_pct'],
            'tendencia_pct_dia':       vol_metrics['tendencia_pct_dia'],
            'persistencia':            round(persistencia, 4) if persistencia is not None else None,
            'n_obs':                   vol_metrics['n_obs'],
            'coupon_dates_iso':        sorted([f'{dt[0]:04d}-{dt[1]:02d}-{dt[2]:02d}' for dt in cupon_dts]),
            'series':                  series_payload,
        }
        out_by_cod[k] = d
        if a['isin']:
            out_by_isin[a['isin']] = d
    return {
        'by_cod_if':       out_by_cod,
        'by_isin':         out_by_isin,
        'period_n_dates':  n_dates_total,
        'period_dates':    [f"{dt[2]:02d}/{dt[1]:02d}/{dt[0]}" for dt in all_dates],
    }


def _b3_match(b3_lookup, ticker, isin=None):
    """Resolve B3 stats por ticker (Codigo IF) ou ISIN."""
    if not b3_lookup: return None
    bc = b3_lookup.get('by_cod_if') or {}
    bi = b3_lookup.get('by_isin') or {}
    t = (ticker or '').strip()
    if t and t in bc: return bc[t]
    if isin and isin in bi: return bi[isin]
    return None


# ── TESOURO ONLINE + CURVA SOBERANA + PREMIO DE RISCO ───────────────────────

_TESOURO_URL = (
    'https://www.tesourotransparente.gov.br/ckan/dataset/'
    'df56aa42-484a-4a59-8184-7676580c81e3/resource/'
    '796d2059-14e9-44e3-80c9-2d9e30b405c1/download/PrecoTaxaTesouroDireto.csv'
)
_TESOURO_TTL_SEC = 6 * 3600
_tesouro_cache = {'data': None, 'fetched_at': 0}
_tesouro_lock  = threading.Lock()


def _fetch_tesouro_online(force=False):
    """Baixa CSV Tesouro Transparente. Cache GLOBAL 6h."""
    import urllib.request, urllib.error, csv as _csv, io as _io
    import datetime as _dt

    with _tesouro_lock:
        cached = _tesouro_cache.get('data')
        cached_at = _tesouro_cache.get('fetched_at', 0)
    if not force and cached and (time.time() - cached_at < _TESOURO_TTL_SEC):
        return cached

    try:
        req = urllib.request.Request(_TESOURO_URL, headers={'User-Agent': 'spread-quality/1.0'})
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return cached

    try:
        text = raw.decode('utf-8-sig', errors='replace')
    except Exception:
        return cached

    reader = _csv.DictReader(_io.StringIO(text), delimiter=';')
    try:
        rows = list(reader)
    except Exception:
        return cached
    if not rows:
        return cached

    sample = rows[0]
    def _find_col(*needles):
        for c in sample:
            low = c.lower()
            if all(n.lower() in low for n in needles):
                return c
        return None

    col_tipo  = _find_col('tipo', 'titulo') or _find_col('tipo')
    col_venc  = _find_col('data', 'vencimento')
    col_base  = _find_col('data', 'base')
    col_taxa_venda  = _find_col('taxa', 'venda')
    col_taxa_compra = _find_col('taxa', 'compra')
    if not (col_tipo and col_venc and col_base):
        return cached

    def _pd(s):
        if not s: return None
        try:
            d, m, y = str(s).strip().split('/')
            return _dt.date(int(y), int(m), int(d))
        except Exception:
            return None

    last_date = None
    for r in rows:
        d = _pd(r.get(col_base))
        if d and (last_date is None or d > last_date):
            last_date = d
    if not last_date:
        return cached

    last_str = last_date.strftime('%d/%m/%Y')
    today = _dt.date.today()

    pre, ipca = [], []
    for r in rows:
        if r.get(col_base) != last_str:
            continue
        tipo = (r.get(col_tipo) or '').strip()
        venc = _pd(r.get(col_venc))
        taxa_str = (r.get(col_taxa_venda) or r.get(col_taxa_compra) or '').strip()
        if not taxa_str or not venc:
            continue
        try:
            taxa = float(taxa_str.replace(',', '.'))
        except ValueError:
            continue
        ttm = (venc - last_date).days / 365.25
        if ttm <= 0:
            continue
        tipo_up = tipo.upper()
        if 'PREFIXADO' in tipo_up:
            pre.append((round(ttm, 4), taxa))
        elif 'IPCA+' in tipo_up or 'RENDA+' in tipo_up or 'IPCA +' in tipo_up:
            ipca.append((round(ttm, 4), taxa))

    pre.sort(key=lambda x: x[0])
    ipca.sort(key=lambda x: x[0])

    data = {
        'PRE':  pre, 'IPCA': ipca, 'IGPM': ipca,
        '_meta': {
            'source': 'Tesouro Transparente',
            'date': last_str,
            'days_old': (today - last_date).days,
            'n_pre': len(pre), 'n_ipca': len(ipca),
            'fetched_at': int(time.time()),
        },
    }
    with _tesouro_lock:
        _tesouro_cache['data']       = data
        _tesouro_cache['fetched_at'] = time.time()
    return data


def _build_curva_soberana():
    """Constroi curvas livres-de-risco por indexador.
    Estrategia: tenta Tesouro online (cache 6h, D-1). Fallback: tp_data manual."""
    online = _fetch_tesouro_online()
    if online and (online.get('PRE') or online.get('IPCA')):
        return {
            'IPCA':  list(online.get('IPCA') or []),
            'PRE':   list(online.get('PRE')  or []),
            'IGPM':  list(online.get('IGPM') or []),
            'CDI%':  [],
            '_source': 'tesouro_online',
            '_meta':   online.get('_meta'),
        }
    tp_data = _compute_tp_data() or []
    curves = {'IPCA': [], 'PRE': [], 'IGPM': [], 'CDI%': [], '_source': 'tp_data_manual'}
    for r in tp_data:
        dur = r.get('duration')
        tx  = r.get('anbima') or r.get('spread_xp')
        tipo = (r.get('tipo') or '').upper()
        if dur is None or tx is None or dur <= 0:
            continue
        if tipo in ('NTN-B', 'NTN-C'):
            curves['IPCA'].append((dur, tx))
            if tipo == 'NTN-C':
                curves['IGPM'].append((dur, tx))
        elif tipo in ('NTN-F', 'LTN'):
            curves['PRE'].append((dur, tx))
        elif tipo == 'LFT':
            curves['CDI%'].append((dur, tx))
    for k in ('IPCA','PRE','IGPM','CDI%'):
        curves[k].sort(key=lambda x: x[0])
    return curves


def _interp_curva(curva, dur):
    """Interpolacao linear na curva. Extrapolacao chata fora dos extremos."""
    if not curva or dur is None:
        return None
    if dur <= curva[0][0]:
        return curva[0][1]
    if dur >= curva[-1][0]:
        return curva[-1][1]
    for i in range(1, len(curva)):
        x0, y0 = curva[i-1]
        x1, y1 = curva[i]
        if x0 <= dur <= x1:
            t = (dur - x0) / (x1 - x0) if x1 > x0 else 0
            return y0 + t * (y1 - y0)
    return None


def _compute_credit_spread(itype, taxa_xp, dur_anos, curves, cdi_rate=None):
    """Premio de risco (em pp) acima da taxa livre de risco."""
    if taxa_xp is None or itype is None:
        return None
    itype = itype.upper()
    if itype == 'CDI+':
        return round(float(taxa_xp), 4)
    if itype == 'CDI%':
        if cdi_rate is None or cdi_rate <= 0:
            return None
        return round((float(taxa_xp) - 100.0) * cdi_rate / 100.0, 4)
    curva = curves.get(itype) if curves else None
    if not curva or dur_anos is None:
        return None
    ref = _interp_curva(curva, dur_anos)
    if ref is None:
        return None
    return round(float(taxa_xp) - float(ref), 4)


# ── DIAGNOSTICO B3 ──────────────────────────────────────────────────────────

_B3_UNMATCHED_VOL_MIN = 100_000


def _compute_unmatched_b3(b3_lookup):
    """Codigos B3 com volume relevante que nao casaram com universo XP."""
    by_cod = (b3_lookup or {}).get('by_cod_if') or {}
    if not by_cod:
        return {'items': [], 'n_total_relevant': 0, 'hidden_low_vol': 0, 'total_b3': 0}

    diag = g.store.get('_b3_diag', {})
    matched = set()
    matched |= diag.get('matched_via_mercado',  set())
    matched |= diag.get('matched_via_catalog',  set())

    items_all = []
    for code, b3 in by_cod.items():
        if code in matched:
            continue
        items_all.append({
            'cod_if':      code,
            'isin':        b3.get('isin'),
            'instr':       b3.get('instr'),
            'emissor':     b3.get('emissor'),
            'vol_total':   b3.get('vol_total') or 0,
            'vol_extra':   b3.get('vol_extra') or 0,
            'n_trades':    b3.get('n_trades') or 0,
            'ratio_extra': b3.get('ratio_extra'),
        })
    items_rel = [i for i in items_all if (i['vol_total'] or 0) >= _B3_UNMATCHED_VOL_MIN]
    items_rel.sort(key=lambda x: -(x['vol_total'] or 0))
    n_total_relevant = len(items_rel)
    hidden_low_vol = len(items_all) - n_total_relevant
    return {
        'items':              items_rel[:500],
        'n_total_relevant':   n_total_relevant,
        'hidden_low_vol':     hidden_low_vol,
        'total_b3':           len(by_cod),
    }


def _finalize_b3_diagnostics():
    """Anexa diagnostico B3 a store['diagnostics']. Chamado apos compute_*."""
    if 'b3_negocios' not in store:
        return
    b3_lookup = compute_b3_lookup()
    unmatched = _compute_unmatched_b3(b3_lookup)
    diag = store.get('diagnostics') or {}
    diag['unmatched_b3'] = unmatched
    counts = diag.get('counts') or {}
    total_b3 = unmatched.get('total_b3', 0)
    n_unmatched_rel  = unmatched.get('n_total_relevant', 0)
    n_hidden_low_vol = unmatched.get('hidden_low_vol', 0)
    counts.update({
        'b3_total':              total_b3,
        'b3_matched':            total_b3 - n_unmatched_rel - n_hidden_low_vol,
        'b3_sem_match':          n_unmatched_rel,
        'b3_sem_match_low_vol':  n_hidden_low_vol,
    })
    diag['counts'] = counts
    store['diagnostics'] = diag


# ── ANALYSIS ENGINE ──────────────────────────────────────────────────────────

def compute_analysis():
    """Join XP produtos + ANBIMA rates + Empresa scores + B3 + premio_risco."""
    produtos     = store.get('produtos', [])
    anbima       = {**store.get('anbima_cri_cra', {}), **store.get('anbima_debentures', {})}
    emp_lookup   = store.get('emp_lookup', {})
    b3_lookup    = compute_b3_lookup() if 'b3_negocios' in store else {}
    curves       = _build_curva_soberana()
    cdi_rate     = (store.get('cdi_rate') or {}).get('rate')
    b3_matched_catalog = set()

    if not produtos or not anbima:
        return {'ipca': [], 'cdi_pct': [], 'cdi_plus': [], 'pre': [], 'outros': [], 'meta': {}}

    # Reference date
    ref_date = next((v.get('data_ref') for v in anbima.values() if v.get('data_ref')), '—')

    ipca, cdi_pct, cdi_plus, pre, outros = [], [], [], [], []

    # Diagnósticos: rastreia tickers/emissores que não casaram para expor via
    # endpoint /api/diagnostics.
    unmatched_tickers   = []   # XP produtos sem match em ANBIMA
    unmatched_emissores = set()  # ANBIMA sem score em empresas
    unknown_itype       = []   # produtos cujo tipo de índice não foi reconhecido

    for prod in produtos:
        ticker = str(prod.get('ticker', '')).strip()
        if not ticker:
            continue

        ref = anbima.get(ticker)
        if not ref:
            unmatched_tickers.append({
                'ticker': ticker,
                'ativo':  prod.get('ativo'),
            })
            continue

        # Parse XP offered rate (commission = min; fee-based = max)
        xp_type, xp_num     = _parse_xp_rate(prod.get('taxa_min'))
        _,        xp_num_fb = _parse_xp_rate(prod.get('taxa_max'))

        # ANBIMA reference rate
        anbima_taxa = ref.get('taxa_indicativa')

        # Δ ANBIMA for both rate modes
        delta    = round(xp_num    - anbima_taxa, 6) if xp_num    is not None and anbima_taxa is not None else None
        delta_fb = round(xp_num_fb - anbima_taxa, 6) if xp_num_fb is not None and anbima_taxa is not None else None

        # Empresa score
        emp = _find_score(ref.get('emissor', ''), emp_lookup)
        if not emp and ref.get('emissor'):
            unmatched_emissores.add(ref['emissor'])

        itype = ref.get('indice_type') or xp_type
        if itype is None:
            unknown_itype.append({'ticker': ticker, 'indice': ref.get('indice_str')})

        # ROA: prefere valor do catálogo XP; fallback = (taxa_max − taxa_min) × duration
        roa_val = prod.get('roa')
        _dur = ref.get('duration')
        if (not roa_val or str(roa_val).strip() in ('-', 'nan')) \
                and xp_num is not None and xp_num_fb is not None and _dur is not None:
            _roa_num = round((xp_num_fb - xp_num) * _dur, 4)
            if _roa_num > 0:
                roa_val = f"{_roa_num:.2f}%".replace('.', ',')

        row = {
            'ativo':         prod.get('ativo'),
            'ticker':        ticker,
            'instrumento':   ref.get('instrumento') or prod.get('instrumento', ''),
            'emissor':       ref.get('emissor', ''),
            'vencimento':    prod.get('vencimento') or ref.get('vencimento'),
            'dur':           ref.get('duration'),
            'rating':        prod.get('rating'),
            'isento':        prod.get('isento'),
            'taxa_xp':       prod.get('taxa_min'),
            'spread_xp':     xp_num,
            'anbima':        anbima_taxa,
            'delta_anbima':  delta,
            'indice_type':   itype,
            'pu':            ref.get('pu'),
            'taxa_compra':   ref.get('taxa_compra'),
            'taxa_venda':    ref.get('taxa_venda'),
            'desvio':        ref.get('desvio'),
            'roa':           roa_val,
            # Both rate modes (commission = min, fee-based = max)
            'taxa_xp_fb':    prod.get('taxa_max'),
            'spread_xp_fb':  xp_num_fb,
            'delta_anbima_fb': delta_fb,
            # Produto fields
            'publico':       prod.get('publico'),
            'juros':         prod.get('juros'),
            'amortizacao':   prod.get('amortizacao'),
            # Empresa
            'score_total':   emp.get('score_total')  if emp else None,
            'score_quant':   emp.get('score_quant')  if emp else None,
            'score_qual':    emp.get('score_qual')   if emp else None,
            'aloc_max':      emp.get('aloc_max')     if emp else None,
            'setor':         emp.get('setor')        if emp else None,
            'rj':            ref.get('rj', False),
            # ANBIMA Compra/Venda + spread bid-ask (book oficial) - propagados
            'anbima_compra':  ref.get('taxa_compra'),
            'anbima_venda':   ref.get('taxa_venda'),
            'anbima_desvio':  ref.get('desvio'),
            'anbima_spread_ba': (round(ref.get('taxa_venda') - ref.get('taxa_compra'), 4)
                                 if ref.get('taxa_compra') is not None and ref.get('taxa_venda') is not None else None),
            # Mesclados de Produtos
            'qtd_min':                   prod.get('qtd_min'),
            'carencia':                  prod.get('carencia'),
            'data_emissao':              prod.get('data_emissao'),
            'primeira_data_juros':       prod.get('primeira_data_juros'),
            'primeira_data_amortizacao': prod.get('primeira_data_amortizacao'),
            'taxa_emissao':              prod.get('taxa_emissao'),
        }

        # Premio de risco sobre curva soberana
        _dur_anos = ref.get('duration')
        if _dur_anos is not None:
            try: _dur_anos = float(_dur_anos)
            except (TypeError, ValueError): _dur_anos = None
        row['premio_risco']    = _compute_credit_spread(itype, xp_num,    _dur_anos, curves, cdi_rate)
        row['premio_risco_fb'] = _compute_credit_spread(itype, xp_num_fb, _dur_anos, curves, cdi_rate)
        if itype in ('IPCA','PRE','IGPM') and _dur_anos is not None:
            row['curva_ref_taxa'] = round(_interp_curva(curves.get(itype) or [], _dur_anos), 4) if curves.get(itype) else None
        else:
            row['curva_ref_taxa'] = None

        # Cronograma de eventos
        row['coupon_schedule'] = _coupon_schedule(row)
        row['next_event'] = row['coupon_schedule'][0] if row['coupon_schedule'] else None

        # B3 - componentes brutos + vol
        b3 = _b3_match(b3_lookup, ticker)
        if b3:
            if b3.get('cod_if'):
                b3_matched_catalog.add(b3['cod_if'])
            row.update({
                'b3_vol_total':       b3.get('vol_total'),
                'b3_vol_extra':       b3.get('vol_extra'),
                'b3_n_trades':        b3.get('n_trades'),
                'b3_pu_medio':        b3.get('pu_medio'),
                'b3_ratio_extra':     b3.get('ratio_extra'),
                'b3_oscilacao':       b3.get('oscilacao'),
                'b3_dias_negociados': b3.get('dias_negociados'),
                'b3_last_date':       b3.get('last_date'),
                'b3_vol_intra_pct':     b3.get('vol_intra_pct'),
                'b3_vol_diaria_std':    b3.get('vol_diaria_std'),
                'b3_vol_period_pct':    b3.get('vol_period_pct'),
                'b3_tendencia_pct_dia': b3.get('tendencia_pct_dia'),
                'b3_persistencia':      b3.get('persistencia'),
                'b3_n_obs':             b3.get('n_obs'),
            })

        # ── Validation ──────────────────────────────────────────────────
        warnings = []
        if xp_type and itype and xp_type != itype:
            warnings.append(f'Tipo XP ({xp_type}) ≠ índice ANBIMA ({itype})')
        if delta is not None and abs(delta) > 8:
            warnings.append(f'Δ ANBIMA extremo: {delta:+.4f} pp')
        # CDI% usa base 0-150% (fundos agressivos passam de 100%); DOLAR é
        # um cupom cambial sobre PTAX, normalmente <15% mas com folga até 50%
        # para emergências; demais (IPCA+, CDI+, PRE, IGPM) trabalham em pontos
        # percentuais de taxa de juros e raramente passam de 30%.
        if   itype == 'CDI%':  _rate_max = 150
        elif itype == 'DOLAR': _rate_max = 50
        else:                  _rate_max = 30
        if xp_num is not None and not (0 < xp_num < _rate_max):
            warnings.append(f'Taxa XP fora do intervalo esperado ({itype or "?"}): {xp_num}')
        if anbima_taxa is not None and not (0 < anbima_taxa < _rate_max):
            warnings.append(f'Taxa ANBIMA fora do intervalo esperado ({itype or "?"}): {anbima_taxa}')
        if warnings:
            row['_warnings'] = warnings

        if   itype == 'IPCA':  ipca.append(row)
        elif itype == 'CDI%':  cdi_pct.append(row)
        elif itype == 'CDI+':  cdi_plus.append(row)
        elif itype == 'PRE':   pre.append(row)
        else:                  outros.append(row)

    def _sort(lst):
        # Best deals first (most positive Δ = XP offering above ANBIMA reference)
        return sorted(lst, key=lambda r: r['delta_anbima']
                      if r['delta_anbima'] is not None else -9999, reverse=True)

    n_matched = len(ipca) + len(cdi_pct) + len(cdi_plus) + len(pre) + len(outros)

    g.store.setdefault('_b3_diag', {})['matched_via_catalog'] = b3_matched_catalog

    # Armazena diagnósticos globais para /api/diagnostics
    store['diagnostics'] = {
        'unmatched_tickers':   unmatched_tickers,
        'unmatched_emissores': sorted(unmatched_emissores),
        'unknown_itype':       unknown_itype,
        'counts': {
            'produtos':  len(produtos),
            'anbima':    len(anbima),
            'matched':   n_matched,
            'sem_match': len(unmatched_tickers),
            'sem_score': len(unmatched_emissores),
            'indice_desconhecido': len(unknown_itype),
        },
    }

    return {
        'ipca':    _sort(ipca),
        'cdi_pct': _sort(cdi_pct),
        'cdi_plus': _sort(cdi_plus),
        'pre':     _sort(pre),
        'outros':  outros,
        'meta': {
            'ref_date':   ref_date,
            'n_produtos': len(produtos),
            'n_anbima':   len(anbima),
            'n_matched':  n_matched,
            'ipca_info':  f'Ref. ANBIMA: {ref_date} | {len(ipca)} ativos IPCA+',
            'cdi_info':   f'Ref. ANBIMA: {ref_date} | {len(cdi_pct)} CDI% + {len(cdi_plus)} CDI+',
        },
    }


# ── TÍTULOS PÚBLICOS ─────────────────────────────────────────────────────────

# Maps XP instrumento string -> ANBIMA paste tipo
_INSTR_TO_TIPO = {
    'NOTA DO TESOURO NACIONAL SÉRIE B': 'NTN-B',
    'NOTA DO TESOURO NACIONAL SÉRIE F': 'NTN-F',
    'LETRA DO TESOURO NACIONAL':        'LTN',
    'LETRA FINANCEIRA DO TESOURO':      'LFT',
    'NOTA DO TESOURO NACIONAL SÉRIE C': 'NTN-C',
}

def _norm_venc(v):
    """Normalise vencimento to dd/mm/yyyy string."""
    if v is None:
        return ''
    if isinstance(v, pd.Timestamp):
        return v.strftime('%d/%m/%Y')
    s = str(v).strip()
    # ISO  yyyy-mm-dd  ->  dd/mm/yyyy
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', s)
    if m:
        return f'{m.group(3)}/{m.group(2)}/{m.group(1)}'
    return s


def _compute_tp_data():
    """Merge XP Títulos Públicos products with ANBIMA paste bonds.

    Returns enriched rows sorted best-Δ first (or by vencimento if no Δ).
    """
    produtos_tp = store.get('produtos_tp', [])
    tp_bonds    = store.get('tp_bonds', [])    # from paste

    if not produtos_tp:
        return []

    # Build paste lookup keyed (tipo_upper, vencimento dd/mm/yyyy)
    paste_lk = {}
    for b in tp_bonds:
        key = (b.get('tipo', '').upper(), b.get('vencimento', '').strip())
        paste_lk[key] = b

    rows = []
    for prod in produtos_tp:
        instr_raw = str(prod.get('instrumento', '')).strip().upper()
        tipo      = _INSTR_TO_TIPO.get(instr_raw, '')
        venc      = _norm_venc(prod.get('vencimento'))

        # ANBIMA paste match
        anbima = paste_lk.get((tipo, venc))

        # Parse XP offered rate
        xp_type, xp_num = _parse_xp_rate(prod.get('taxa_min'))
        anbima_taxa = anbima.get('taxa_indicativa') if anbima else None

        delta = None
        if xp_num is not None and anbima_taxa is not None:
            delta = round(xp_num - anbima_taxa, 6)

        rows.append({
            'ativo':         prod.get('ativo'),
            'tipo':          tipo,
            'instrumento':   instr_raw,
            'vencimento':    venc,
            'duration':      prod.get('duration_xp'),
            'juros':         prod.get('juros'),
            'amortizacao':   prod.get('amortizacao'),
            'publico':       prod.get('publico'),
            'taxa_xp':       prod.get('taxa_min'),
            'spread_xp':     xp_num,
            'indice_type':   xp_type,
            'anbima':        anbima_taxa,
            'delta_anbima':  delta,
            'pu':            anbima.get('pu')       if anbima else None,
            'int_min':       anbima.get('int_min')  if anbima else None,
            'int_max':       anbima.get('int_max')  if anbima else None,
            'rentabilidade': anbima.get('rentabilidade') if anbima else prod.get('indexador'),
        })

    # Sort: matched rows (with delta) first, then by vencimento
    return sorted(rows, key=lambda r: (
        r['delta_anbima'] is None,
        -(r['delta_anbima'] or 0),
        r['vencimento'] or ''
    ))


def _parse_titulos_text(text):
    """Parse ANBIMA website copy-paste text for Títulos Públicos.

    Each block begins with:  LFT•Tesouro Selic 2026
    Then alternating label/value lines until the next block.
    """
    FIELD_MAP = {
        'Data da emissão':              'emissao',
        'Data de vencimento':           'vencimento',
        'Código SELIC':                 'codigo',
        'Rentabilidade':                'rentabilidade',
        'Intervalo indic. mín. (D0)':   'int_min',
        'Intervalo indic. máx. (D0)':   'int_max',
        'Taxa de compra':               'taxa_compra',
        'Taxa de venda':                'taxa_venda',
        'Taxa indicativa':              'taxa_indicativa',
        'VNA':                          'vna',
        'Duration (dias úteis)':        'duration',
        'PU Indicativo':                'pu',
    }
    NUMERIC = {'int_min', 'int_max', 'taxa_compra', 'taxa_venda',
               'taxa_indicativa', 'vna', 'duration', 'pu'}

    BOND_RE = re.compile(r'^(LFT|LTN|NTN-B|NTN-C|NTN-F)\s*[•·]\s*(.+)', re.IGNORECASE)

    lines = [l.strip() for l in text.splitlines() if l.strip()]
    bonds = []
    cur   = None

    i = 0
    while i < len(lines):
        line = lines[i]
        m = BOND_RE.match(line)
        if m:
            if cur:
                bonds.append(cur)
            cur = {'tipo': m.group(1).upper(), 'nome': m.group(2).strip()}
            i += 1
            continue

        if cur is None:
            i += 1
            continue

        # Known label -> next line is its value
        if line in FIELD_MAP and i + 1 < len(lines):
            raw = lines[i + 1]
            # Skip if next line is another bond header or "Abrir histór..."
            if BOND_RE.match(raw) or raw.lower().startswith('abrir'):
                i += 1
                continue
            field = FIELD_MAP[line]
            clean = raw.replace('R$', '').strip()
            if field in NUMERIC:
                num = _num(clean)
                cur[field] = num if num is not None else clean
            else:
                cur[field] = clean
            i += 2
        else:
            i += 1

    if cur:
        bonds.append(cur)

    # Normalização: duration em TP vem em dias úteis (DU). Convertemos para anos
    # (DU/252) para alinhar com ANBIMA (que já reporta em anos). Preservamos o
    # valor original em 'duration_du' para auditoria.
    for b in bonds:
        d = b.get('duration')
        if isinstance(d, (int, float)) and d > 50:   # > 50 anos é implausível -> é DU
            b['duration_du']  = d
            b['duration']     = round(d / 252.0, 3)

    return bonds


# ── DETECTION ────────────────────────────────────────────────────────────────

def detect_and_parse(fb, filename=''):
    fname = filename.lower()

    if fname.endswith('.csv'):
        # Peek 8KB para detectar B3 (preambulo) / mercado / anbima
        fb.seek(0)
        peek = fb.read(8192).decode('utf-8-sig', errors='replace')
        fb.seek(0)
        # B3 - header tem "Codigo IF" + "Volume financeiro"
        if ('Código IF' in peek or 'Codigo IF' in peek) and 'Volume financeiro' in peek:
            data = parse_b3_negocios(fb, filename)
            return ('b3_negocios', data, None) if data else (None, None, 'CSV B3 vazio ou invalido')
        if 'Emissor / Risco' in peek or 'BID Mercado' in peek:
            data = parse_mercado(fb)
            return ('mercado', data, None) if data else (None, None, 'CSV mercado vazio ou invalido')
        data = parse_anbima_cri_cra(fb)
        return ('anbima_cri_cra', data, None) if data else (None, None, 'CSV vazio ou invalido')

    if fname.endswith('.xls'):
        data = parse_anbima_debentures(fb)
        return ('anbima_debentures', data, None) if data else (None, None, 'XLS vazio ou invalido')

    if fname.endswith('.xlsx'):
        xl = pd.ExcelFile(fb)
        sheets = xl.sheet_names
        fb.seek(0)
        if 'Empresas' in sheets:
            rows, lookup = parse_empresas(fb)
            store['emp_lookup'] = lookup
            return 'empresas', rows, None
        if 'Resultado' in sheets:
            df_peek = xl.parse('Resultado', nrows=20)
            is_tp = False
            if 'Instrumento' in df_peek.columns:
                instrs = df_peek['Instrumento'].dropna().astype(str).str.upper()
                tp_kw  = ['NOTA DO TESOURO', 'LETRA DO TESOURO', 'LETRA FINANCEIRA DO TESOURO']
                tp_cnt = sum(any(kw in i for kw in tp_kw) for i in instrs)
                is_tp  = tp_cnt >= max(1, len(instrs) * 0.5)
            fb.seek(0)
            if is_tp:
                return 'produtos_tp', parse_produtos(fb), None
            return 'produtos', parse_produtos(fb), None
        # Heuristica B3 em XLSX
        first = xl.parse(sheets[0], nrows=1)
        cols0 = [str(c).strip() for c in first.columns]
        if any('código if' == c.lower() or 'codigo if' == c.lower() for c in cols0):
            fb.seek(0)
            data = parse_b3_negocios(fb, filename)
            return ('b3_negocios', data, None) if data else (None, None, 'XLSX B3 vazio ou invalido')

    return None, None, f'Formato nao reconhecido: {filename}'


# ── ROUTES ───────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/upload', methods=['POST'])
def upload():
    resp = {'processed': [], 'errors': [], 'loaded': []}
    for _, f in request.files.items():
        if not f or not f.filename:
            continue
        try:
            fb = io.BytesIO(f.read())
            ftype, data, err = detect_and_parse(fb, f.filename)
            if err:
                resp['errors'].append({'file': f.filename, 'error': err})
            else:
                store[ftype] = data
                resp['processed'].append({'file': f.filename, 'type': ftype})
        except Exception as e:
            resp['errors'].append({'file': f.filename, 'error': str(e)})

    # Reset tracking de match B3 (sera preenchido por compute_*)
    g.store['_b3_diag'] = {}

    if 'produtos' in store and ('anbima_cri_cra' in store or 'anbima_debentures' in store):
        store['analysis'] = compute_analysis()

    if 'mercado' in store:
        store['mercado_analysis'] = compute_mercado_analysis()

    if 'mercado_analysis' in store and 'analysis' in store:
        store['oportunidades'] = compute_oportunidades()

    _finalize_b3_diagnostics()

    resp['loaded'] = [k for k in store if k not in ('emp_lookup', 'tp_bonds', 'mercado_analysis', 'oportunidades', 'diagnostics', 'cdi_rate', 'tesouro_online') and not k.startswith('_')]
    return jsonify(resp)


@app.route('/api/data')
def get_data():
    analysis = store.get('analysis') or {
        'ipca': [], 'cdi_pct': [], 'cdi_plus': [], 'pre': [], 'outros': [], 'meta': {}
    }
    # Collect validation warnings from all credit buckets
    all_warnings = []
    for bucket in ('ipca', 'cdi_pct', 'cdi_plus', 'pre', 'outros'):
        for row in analysis.get(bucket, []):
            if row.get('_warnings'):
                all_warnings.append({
                    'ticker':   row.get('ticker'),
                    'emissor':  row.get('emissor'),
                    'warnings': row['_warnings'],
                })

    # B3 - meta + enriquecimento das rows com metricas de vol
    b3_rows = store.get('b3_negocios', []) or []
    b3_meta = None
    if b3_rows:
        datas = sorted({r.get('data','') for r in b3_rows if r.get('data')})
        b3_lookup = compute_b3_lookup() or {}
        by_cod = b3_lookup.get('by_cod_if') or {}
        VOL_KEYS = ('vol_intra_pct', 'vol_diaria_std', 'vol_period_pct',
                    'tendencia_pct_dia', 'persistencia', 'n_obs', 'dias_negociados')
        b3_rows_enriched = []
        for r in b3_rows:
            agg = by_cod.get(r.get('cod_if')) or {}
            enriched = {**r}
            for k in VOL_KEYS:
                enriched[f'b3_{k}'] = agg.get(k)
            b3_rows_enriched.append(enriched)
        b3_rows = b3_rows_enriched
        b3_meta = {
            'n_rows':       len(b3_rows),
            'datas':        datas,
            'date_first':   datas[0]  if datas else '',
            'date_last':    datas[-1] if datas else '',
            'vol_total':    round(sum(r.get('vol_total') or 0  for r in b3_rows), 2),
            'vol_extra':    round(sum(r.get('vol_extra') or 0  for r in b3_rows), 2),
            'n_trades':     sum(int(r.get('n_trades') or 0)    for r in b3_rows),
            'n_papeis':     len({r['cod_if'] for r in b3_rows if r.get('cod_if')}),
            'period_n_dates': b3_lookup.get('period_n_dates', 0),
            'period_dates':   b3_lookup.get('period_dates', []),
        }

    # Curvas soberanas
    curves = _build_curva_soberana()
    curves_meta = {'source': curves.get('_source', 'unknown'), 'meta': curves.get('_meta')}

    return jsonify({
        'loaded':       [k for k in store if k not in ('emp_lookup', 'tp_bonds', 'mercado_analysis', 'oportunidades', 'diagnostics', 'cdi_rate', 'tesouro_online') and not k.startswith('_')],
        'spread_score': analysis,
        'empresas':     store.get('empresas', []),
        'produtos':     store.get('produtos', []),
        'tp_data':      _compute_tp_data(),
        'mercado':      store.get('mercado_analysis', []),
        'oportunidades': store.get('oportunidades', []),
        'b3_negocios':  b3_rows,
        'b3_meta':      b3_meta,
        'curves':       {k: [list(p) for p in v] for k, v in curves.items() if not k.startswith('_')},
        'curves_meta':  curves_meta,
        'cdi_rate':     (store.get('cdi_rate') or {}).get('rate'),
        'validation':   all_warnings,
    })


@app.route('/api/cdi-rate')
def cdi_rate():
    """Busca a taxa CDI anualizada mais recente do BCB (série SGS 4389).

    Resposta: { rate: float (% a.a.), date: 'dd/mm/aaaa' } ou { error, fallback }.
    Frontend usa para atualizar `state.cdiRate` automaticamente. Tem fallback
    silencioso se a chamada falhar (timeout, BCB offline) — a UI mantém o
    valor antigo (10.65) sem quebrar.
    """
    import urllib.request, urllib.error, json as _json
    URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs.4389/dados/ultimos/1?formato=json'
    try:
        with urllib.request.urlopen(URL, timeout=4) as r:
            payload = _json.loads(r.read().decode('utf-8'))
        if not payload:
            return jsonify({'error': 'BCB retornou vazio', 'fallback': 10.65}), 502
        last = payload[-1]
        rate = float(str(last.get('valor', '')).replace(',', '.'))
        date = str(last.get('data', '')).strip()
        # Cache simples no store da sessão
        g.store['cdi_rate'] = {'rate': rate, 'date': date, 'fetched_at': time.time()}
        return jsonify({'rate': rate, 'date': date})
    except (urllib.error.URLError, ValueError, TimeoutError) as e:
        # Reaproveita cache se houver
        cached = g.store.get('cdi_rate')
        if cached and time.time() - cached.get('fetched_at', 0) < 86400:
            return jsonify({'rate': cached['rate'], 'date': cached.get('date',''), 'cached': True})
        return jsonify({'error': str(e), 'fallback': 10.65}), 502


@app.route('/api/curves-refresh', methods=['POST', 'GET'])
def curves_refresh():
    """Forca refresh do Tesouro online (ignora cache de 6h)."""
    data = _fetch_tesouro_online(force=True)
    if data is None:
        return jsonify({'error': 'Falha ao baixar do Tesouro Transparente. Tente novamente.'}), 502
    return jsonify({
        'curves': {k: [list(p) for p in v] for k, v in data.items() if not k.startswith('_')},
        'meta':   data.get('_meta'),
    })


@app.route('/api/b3-papel/<path:cod_if>')
def b3_papel_detail(cod_if):
    """Detalhe completo de um papel B3 - serie temporal + metricas."""
    if 'b3_negocios' not in store:
        return jsonify({'error': 'sem b3_negocios carregado'}), 404
    lookup = compute_b3_lookup() or {}
    by_cod = lookup.get('by_cod_if') or {}
    cod_if = (cod_if or '').strip()
    item = by_cod.get(cod_if)
    if not item:
        return jsonify({'error': f'Codigo IF nao encontrado: {cod_if}'}), 404
    return jsonify({
        'cod_if':           item['cod_if'],
        'isin':             item['isin'],
        'instr':            item['instr'],
        'emissor':          item['emissor'],
        'vol_total':        item['vol_total'],
        'vol_extra':        item['vol_extra'],
        'vol_intra':        item['vol_intra'],
        'n_trades':         item['n_trades'],
        'pu_medio':         item['pu_medio'],
        'pu_min':           item['pu_min'],
        'pu_max':           item['pu_max'],
        'ratio_extra':      item['ratio_extra'],
        'dias_negociados':  item['dias_negociados'],
        'last_date':        item['last_date'],
        'vol_intra_pct':           item['vol_intra_pct'],
        'vol_diaria_std':          item['vol_diaria_std'],
        'vol_diaria_std_ex_cupom': item.get('vol_diaria_std_ex_cupom'),
        'n_excluded_cupom':        item.get('n_excluded_cupom', 0),
        'vol_period_pct':          item['vol_period_pct'],
        'tendencia_pct_dia':       item['tendencia_pct_dia'],
        'persistencia':            item['persistencia'],
        'n_obs':                   item['n_obs'],
        'series':            item['series'],
        'coupon_dates_iso':  item.get('coupon_dates_iso', []),
        'period_dates':      lookup.get('period_dates', []),
        'period_n_dates':    lookup.get('period_n_dates', 0),
    })


@app.route('/api/diagnostics')
def get_diagnostics():
    """Lista matches que falharam (produtos sem ANBIMA, emissores sem score,
    indexadores desconhecidos, codigos B3 sem cobertura XP)."""
    return jsonify(store.get('diagnostics') or {
        'unmatched_tickers':   [],
        'unmatched_emissores': [],
        'unknown_itype':       [],
        'unmatched_b3':        {'items': [], 'n_total_relevant': 0, 'hidden_low_vol': 0, 'total_b3': 0},
        'counts': {},
    })


@app.route('/api/titulos-publicos', methods=['POST'])
def titulos_publicos():
    data  = request.get_json(silent=True) or {}
    text  = data.get('text', '')
    bonds = _parse_titulos_text(text)
    store['tp_bonds'] = bonds           # persist for cross-join with produtos_tp
    tp_data = _compute_tp_data()
    return jsonify({'bonds': bonds, 'count': len(bonds), 'tp_data': tp_data})


if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5001)
