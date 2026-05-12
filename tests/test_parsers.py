"""Testes unitários dos helpers puros de app.py.

Rodar sem dependências extras:
    python3 -m unittest discover tests
Ou com pytest (se instalado):
    python3 -m pytest tests/
"""
import os
import sys
import unittest

import pandas as pd

# Permite importar app.py do diretório pai
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import (  # noqa: E402
    _parse_xp_rate,
    _infer_type_from_indice,
    _norm,
    _norm_venc,
    _find_score,
    _num,
    _interp_curva,
    _compute_credit_spread,
    _coupon_schedule,
    _add_months,
    _parse_date_any,
    _norm_freq,
)


class TestParseXpRate(unittest.TestCase):
    def test_ipca(self):
        self.assertEqual(_parse_xp_rate('IPC-A + 6,30%'), ('IPCA', 6.30))
        self.assertEqual(_parse_xp_rate('IPCA + 7,80%'),  ('IPCA', 7.80))

    def test_cdi_plus(self):
        self.assertEqual(_parse_xp_rate('CDI + 1,75%'), ('CDI+', 1.75))
        self.assertEqual(_parse_xp_rate('DI + 2,10%'),  ('CDI+', 2.10))

    def test_cdi_percent(self):
        self.assertEqual(_parse_xp_rate('101,1% CDI'), ('CDI%', 101.1))
        self.assertEqual(_parse_xp_rate('98% do DI'),  ('CDI%', 98.0))

    def test_pre(self):
        self.assertEqual(_parse_xp_rate('15,14%'), ('PRE', 15.14))

    def test_igpm(self):
        self.assertEqual(_parse_xp_rate('IGP-M + 6,55%'), ('IGPM', 6.55))

    def test_empty(self):
        self.assertEqual(_parse_xp_rate(''),    (None, None))
        self.assertEqual(_parse_xp_rate('nan'), (None, None))
        self.assertEqual(_parse_xp_rate(None),  (None, None))

    def test_regex_rejects_multidot(self):
        """Regex antigo aceitava '5.35.99' e crashava no float(). Agora rejeita."""
        # Mesmo com basura, devolve (None, None) sem lançar
        self.assertEqual(_parse_xp_rate('5.35.99'),  (None, None))
        self.assertEqual(_parse_xp_rate('IPCA + 5.35.99'), ('IPCA', 5.35))  # primeiro número OK


class TestNum(unittest.TestCase):
    """Bug #2: volumes em formato BR de milhar (1.234.567) tinham que virar None,
    agora viram 1234567 corretamente."""
    def test_anglo_decimal(self):
        self.assertEqual(_num('7.18'),  7.18)
        self.assertEqual(_num('13.5'),  13.5)

    def test_br_decimal(self):
        self.assertEqual(_num('7,18'),  7.18)
        self.assertEqual(_num('13,896'), 13.896)

    def test_br_thousands_then_decimal(self):
        self.assertEqual(_num('1.234,56'), 1234.56)

    def test_br_pure_thousands(self):
        """Múltiplos pontos sem vírgula → milhar BR."""
        self.assertEqual(_num('1.234.567'), 1234567.0)
        self.assertEqual(_num('123.456'),    123.456)  # 1 ponto: ambíguo, mantém float
        self.assertEqual(_num('12.345.678'), 12345678.0)

    def test_int(self):
        self.assertEqual(_num('1500'), 1500.0)
        self.assertEqual(_num(1500), 1500.0)

    def test_invalid(self):
        self.assertIsNone(_num(''))
        self.assertIsNone(_num('--'))
        self.assertIsNone(_num('nan'))
        self.assertIsNone(_num(None))
        self.assertIsNone(_num('abc'))


class TestInferType(unittest.TestCase):
    def test_ipca(self):
        self.assertEqual(_infer_type_from_indice('IPCA'),   'IPCA')
        self.assertEqual(_infer_type_from_indice('IPC-A+'), 'IPCA')

    def test_cdi(self):
        self.assertEqual(_infer_type_from_indice('CDI + 1%'), 'CDI+')
        self.assertEqual(_infer_type_from_indice('DI+'),      'CDI+')
        self.assertEqual(_infer_type_from_indice('CDI'),      'CDI%')
        self.assertEqual(_infer_type_from_indice('DI'),       'CDI%')

    def test_igpm(self):
        self.assertEqual(_infer_type_from_indice('IGP-M'), 'IGPM')

    def test_pre(self):
        self.assertEqual(_infer_type_from_indice('PRE'),       'PRE')
        self.assertEqual(_infer_type_from_indice('PREFIXADO'), 'PRE')
        self.assertEqual(_infer_type_from_indice('PRÉ'),       'PRE')

    def test_unknown_returns_none(self):
        """Não deve mais fazer fallback silencioso para 'PRE'."""
        self.assertIsNone(_infer_type_from_indice('DOLAR'))
        self.assertIsNone(_infer_type_from_indice('XYZ'))
        self.assertIsNone(_infer_type_from_indice(''))
        self.assertIsNone(_infer_type_from_indice(None))


class TestNorm(unittest.TestCase):
    def test_strips_accents_and_suffixes(self):
        self.assertEqual(_norm('Petrobrás S.A.'),      'PETROBRAS')
        self.assertEqual(_norm('MRV Engenharia LTDA'), 'MRV ENGENHARIA')

    def test_empty(self):
        self.assertEqual(_norm(''),   '')
        self.assertEqual(_norm(None), '')


class TestNormVenc(unittest.TestCase):
    def test_timestamp(self):
        self.assertEqual(_norm_venc(pd.Timestamp('2030-08-15')), '15/08/2030')

    def test_iso(self):
        self.assertEqual(_norm_venc('2030-08-15'), '15/08/2030')

    def test_already_br(self):
        self.assertEqual(_norm_venc('15/08/2030'), '15/08/2030')

    def test_empty(self):
        self.assertEqual(_norm_venc(None), '')
        self.assertEqual(_norm_venc(''),   '')


class TestFindScore(unittest.TestCase):
    @staticmethod
    def _lu(*names):
        return {_norm(n): {'nome': n, 'score_total': 8.0} for n in names}

    def test_exact_match(self):
        lu = self._lu('MRV ENGENHARIA')
        self.assertEqual(_find_score('MRV ENGENHARIA', lu)['nome'], 'MRV ENGENHARIA')

    def test_with_suffix(self):
        lu = self._lu('MRV Engenharia LTDA')
        result = _find_score('MRV Engenharia', lu)
        self.assertIsNotNone(result)
        self.assertEqual(result['nome'], 'MRV Engenharia LTDA')

    def test_ignores_short_substring(self):
        """'ABC' (3 letras) não deve bater em 'ABCDEF' por substring;
        agora exige palavra inteira para nomes ≤3 letras."""
        lu = self._lu('ABC')
        self.assertIsNone(_find_score('ABCDEF', lu))

    def test_short_word_match(self):
        """Bug #6: nomes curtos como 'MRV' devem casar quando aparecem como
        palavra inteira no nome ANBIMA — antes _FIND_SCORE_MIN_LEN=4 ignorava."""
        lu = self._lu('MRV')  # 3 letras — agora é admitido
        result = _find_score('MRV ENGENHARIA', lu)
        self.assertIsNotNone(result)
        self.assertEqual(result['nome'], 'MRV')

    def test_short_no_word_boundary(self):
        """'MRV' não deve casar em 'MRVPRO' — não é palavra inteira."""
        lu = self._lu('MRV')
        self.assertIsNone(_find_score('MRVPRO', lu))

    def test_tie_break_prefers_closer_size(self):
        lu = {
            _norm('PETROBRAS'): {'nome': 'PETROBRAS', 'score_total': 9},
            _norm('PETROBRAS HOLDING DO BRASIL INTERNACIONAL'):
                                {'nome': 'PETROBRAS_HOLDING', 'score_total': 4},
        }
        result = _find_score('Petrobras', lu)
        self.assertEqual(result['nome'], 'PETROBRAS')

    def test_empty_inputs(self):
        self.assertIsNone(_find_score('',    self._lu('MRV')))
        self.assertIsNone(_find_score('MRV', {}))
        self.assertIsNone(_find_score(None,  self._lu('MRV')))


class TestB3Parser(unittest.TestCase):
    """Testes do parser B3 — agregação e ratio extragrupo."""

    @staticmethod
    def _csv_to_fb(csv_str):
        import io
        return io.BytesIO(csv_str.encode('utf-8'))

    def test_basic_aggregation_intra_extra(self):
        """Soma INTRAGRUPO+EXTRAGRUPO no mesmo (cod_if, data) e calcula ratio."""
        from app import parse_b3_negocios
        csv = '''Data negócio;Código IF;Instrumento financeiro;Código ISIN;Emissor;Data liquidação;Quantidade negociada;Preço mínimo;Preço médio;Preço máximo;Último preço;Preço de referência;Número de negócios;Volume financeiro (R$);Classificação do negócio;Oscilação
06/04/26;X1;CRI;BRX1CRI001;ISSUER A;06/04/26;100;1000,00;1000,50;1001,00;1001,00;1000,50;5;100050,00;INTRAGRUPO;0,05
06/04/26;X1;CRI;BRX1CRI001;ISSUER A;07/04/26;200;1000,00;1000,50;1001,00;1001,00;1000,50;3;200100,00;EXTRAGRUPO;0,05
'''
        out = parse_b3_negocios(self._csv_to_fb(csv), 'b3.csv')
        self.assertEqual(len(out), 1)
        r = out[0]
        self.assertEqual(r['cod_if'], 'X1')
        self.assertAlmostEqual(r['vol_total'], 300150.0, places=2)
        self.assertAlmostEqual(r['vol_intra'], 100050.0, places=2)
        self.assertAlmostEqual(r['vol_extra'], 200100.0, places=2)
        self.assertEqual(r['n_trades'], 8)
        # Ratio = 200100 / 300150 ≈ 0.6667
        self.assertAlmostEqual(r['ratio_extra'], 0.6667, places=3)

    def test_ratio_zero_when_only_intra(self):
        """Ratio = 0 quando 100% intragrupo."""
        from app import parse_b3_negocios
        csv = '''Data negócio;Código IF;Instrumento financeiro;Código ISIN;Emissor;Data liquidação;Quantidade negociada;Preço mínimo;Preço médio;Preço máximo;Último preço;Preço de referência;Número de negócios;Volume financeiro (R$);Classificação do negócio;Oscilação
06/04/26;Y1;CRA;BRY1CRA001;ISSUER B;06/04/26;50;500,00;505,00;510,00;510,00;505,00;2;25250,00;INTRAGRUPO;0,1
'''
        out = parse_b3_negocios(self._csv_to_fb(csv), 'b3.csv')
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['ratio_extra'], 0.0)
        self.assertEqual(out[0]['vol_extra'], 0.0)

    def test_ratio_one_when_only_extra(self):
        """Ratio = 1.0 quando 100% extragrupo."""
        from app import parse_b3_negocios
        csv = '''Data negócio;Código IF;Instrumento financeiro;Código ISIN;Emissor;Data liquidação;Quantidade negociada;Preço mínimo;Preço médio;Preço máximo;Último preço;Preço de referência;Número de negócios;Volume financeiro (R$);Classificação do negócio;Oscilação
06/04/26;Z1;CDCA;BRZ1CDC001;ISSUER C;06/04/26;500;1000,00;1000,00;1000,00;1000,00;1000,00;10;500000,00;EXTRAGRUPO;0,0
'''
        out = parse_b3_negocios(self._csv_to_fb(csv), 'b3.csv')
        self.assertEqual(out[0]['ratio_extra'], 1.0)
        self.assertEqual(out[0]['vol_extra'], 500000.0)
        self.assertEqual(out[0]['vol_intra'], 0.0)

    def test_pu_medio_weighted_by_volume(self):
        """PU médio é ponderado por volume, não simples."""
        from app import parse_b3_negocios
        # Linha 1: PU=1000 com vol R$1000 (peso 1)
        # Linha 2: PU=2000 com vol R$3000 (peso 3)
        # Esperado: (1000*1000 + 2000*3000) / 4000 = 7000000/4000 = 1750
        csv = '''Data negócio;Código IF;Instrumento financeiro;Código ISIN;Emissor;Data liquidação;Quantidade negociada;Preço mínimo;Preço médio;Preço máximo;Último preço;Preço de referência;Número de negócios;Volume financeiro (R$);Classificação do negócio;Oscilação
06/04/26;W1;CRI;BRW1CRI001;ISSUER D;06/04/26;1;1000,00;1000,00;1000,00;1000,00;1000,00;1;1000,00;INTRAGRUPO;0
06/04/26;W1;CRI;BRW1CRI001;ISSUER D;06/04/26;1;2000,00;2000,00;2000,00;2000,00;2000,00;1;3000,00;EXTRAGRUPO;0
'''
        out = parse_b3_negocios(self._csv_to_fb(csv), 'b3.csv')
        self.assertEqual(len(out), 1)
        self.assertAlmostEqual(out[0]['pu_medio'], 1750.0, places=2)

    def test_classification_dash_treated_as_mercado(self):
        """Linhas com classificação '-' (CFF/CDCA/CPR sem distinção INTRA/EXTRA)
        contam para vol_total mas não interferem no ratio."""
        from app import parse_b3_negocios
        csv = '''Data negócio;Código IF;Instrumento financeiro;Código ISIN;Emissor;Data liquidação;Quantidade negociada;Preço mínimo;Preço médio;Preço máximo;Último preço;Preço de referência;Número de negócios;Volume financeiro (R$);Classificação do negócio;Oscilação
06/04/26;F1;CFF;BRF1CFF001;FIDC X;06/04/26;100;1000,00;1000,00;1000,00;1000,00;1000,00;3;100000,00;-;0
'''
        out = parse_b3_negocios(self._csv_to_fb(csv), 'b3.csv')
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]['vol_mercado'], 100000.0)
        self.assertEqual(out[0]['vol_total'], 100000.0)
        self.assertEqual(out[0]['vol_intra'], 0.0)
        self.assertEqual(out[0]['vol_extra'], 0.0)
        self.assertEqual(out[0]['ratio_extra'], 0.0)


class TestB3Volatility(unittest.TestCase):
    """Métricas de volatilidade derivadas da série temporal."""

    def test_volatility_metrics_structure(self):
        """Função pura: dados conhecidos → métricas conhecidas."""
        from app import _compute_volatility_metrics
        # 3 dias com PU subindo 1% ao dia: 100 → 101 → 102.01
        # ranges: ±0,5% / ±0,5% / ±0,5%
        series = [
            ((2026,4,6),  100.00, 1000, 99.5,  100.5, 0.5, 5),
            ((2026,4,7),  101.00, 1500, 100.5, 101.5, 0.5, 8),
            ((2026,4,8),  102.01, 2000, 101.5, 102.5, 0.5, 10),
        ]
        m = _compute_volatility_metrics(series)
        self.assertEqual(m['n_obs'], 3)
        # vol_intra ≈ 0.99% (média de ranges/médio)
        self.assertAlmostEqual(m['vol_intra_pct'], 0.99, places=1)
        # vol_period ≈ (102.5 - 99.5)/101 ~ 2.97%
        self.assertGreater(m['vol_period_pct'], 2.5)
        self.assertLess(m['vol_period_pct'], 3.5)
        # tendência > 0 (PU subindo)
        self.assertGreater(m['tendencia_pct_dia'], 0)

    def test_volatility_with_one_day(self):
        """1 dia: sem retornos diários, mas tem vol intra e range."""
        from app import _compute_volatility_metrics
        series = [((2026,4,6), 100, 1000, 99, 101, 0, 5)]
        m = _compute_volatility_metrics(series)
        self.assertEqual(m['n_obs'], 1)
        self.assertIsNone(m['vol_diaria_std'])
        self.assertIsNone(m['tendencia_pct_dia'])
        self.assertIsNotNone(m['vol_intra_pct'])
        self.assertIsNotNone(m['vol_period_pct'])

    def test_volatility_with_no_data(self):
        """Sem PU válido: tudo None."""
        from app import _compute_volatility_metrics
        m = _compute_volatility_metrics([])
        self.assertEqual(m['n_obs'], 0)
        self.assertIsNone(m['vol_intra_pct'])
        self.assertIsNone(m['vol_diaria_std'])
        self.assertIsNone(m['tendencia_pct_dia'])

    def test_volatility_constant_pu(self):
        """PU sempre igual: vol_diaria = 0, range = 0, tendência = 0."""
        from app import _compute_volatility_metrics
        series = [
            ((2026,4,6), 100, 1000, 100, 100, 0, 5),
            ((2026,4,7), 100, 1000, 100, 100, 0, 5),
            ((2026,4,8), 100, 1000, 100, 100, 0, 5),
        ]
        m = _compute_volatility_metrics(series)
        self.assertEqual(m['vol_intra_pct'], 0.0)
        self.assertAlmostEqual(m['vol_diaria_std'], 0.0, places=4)
        self.assertEqual(m['vol_period_pct'], 0.0)
        self.assertEqual(m['tendencia_pct_dia'], 0.0)

    def test_parse_br_date(self):
        """Datas dd/mm/yyyy e dd/mm/yy convertem corretamente."""
        from app import _parse_br_date
        self.assertEqual(_parse_br_date('06/04/2026'), (2026, 4, 6))
        self.assertEqual(_parse_br_date('06/04/26'), (2026, 4, 6))
        self.assertEqual(_parse_br_date('31/12/2025'), (2025, 12, 31))
        self.assertIsNone(_parse_br_date(''))
        self.assertIsNone(_parse_br_date(None))
        self.assertIsNone(_parse_br_date('abc'))


class TestCurvaSoberana(unittest.TestCase):
    """Curva soberana e cálculo de spread de crédito."""

    CURVA_IPCA = [(2.0, 7.0), (5.0, 7.5), (10.0, 8.0)]

    def test_interp_linear_interior(self):
        """Interpolação linear entre pontos. 3.5y entre (2,7) e (5,7.5) → 7.25"""
        self.assertAlmostEqual(_interp_curva(self.CURVA_IPCA, 3.5), 7.25, places=4)

    def test_interp_extrapola_extremos(self):
        """Fora dos extremos: usa valor do ponto mais próximo (flat extrapolation)."""
        self.assertEqual(_interp_curva(self.CURVA_IPCA, 0.5), 7.0)
        self.assertEqual(_interp_curva(self.CURVA_IPCA, 15.0), 8.0)

    def test_interp_curva_vazia(self):
        self.assertIsNone(_interp_curva([], 5.0))
        self.assertIsNone(_interp_curva(self.CURVA_IPCA, None))

    def test_spread_ipca(self):
        """IPCA: spread = taxa_papel − curva interpolada na duration."""
        # papel: IPCA+ com 10.5% a.a., duration 3.5y → curva = 7.25, spread = +3.25
        s = _compute_credit_spread('IPCA', 10.5, 3.5, {'IPCA': self.CURVA_IPCA})
        self.assertAlmostEqual(s, 3.25, places=2)

    def test_spread_cdi_plus_eh_proprio_valor(self):
        """CDI+: a taxa_xp já é o spread sobre Selic. Devolver direto."""
        self.assertEqual(_compute_credit_spread('CDI+', 1.75, None, {}), 1.75)
        self.assertEqual(_compute_credit_spread('CDI+', 2.30, 7.0, {}), 2.30)

    def test_spread_cdi_pct_converte_em_pp_absoluto(self):
        """CDI%: (% - 100) × CDI / 100 → spread em pp absolutas sobre Selic."""
        # 105% CDI com CDI=14.65 → +0.7325 pp
        s = _compute_credit_spread('CDI%', 105.0, None, {}, cdi_rate=14.65)
        self.assertAlmostEqual(s, 0.7325, places=4)
        # 95% CDI com CDI=14.65 → spread negativo (papel paga abaixo do Selic)
        s = _compute_credit_spread('CDI%', 95.0, None, {}, cdi_rate=14.65)
        self.assertAlmostEqual(s, -0.7325, places=4)
        # Sem CDI rate → None (não consegue calcular)
        self.assertIsNone(_compute_credit_spread('CDI%', 105.0, None, {}))

    def test_spread_sem_curva(self):
        """IPCA/PRE sem curva carregada → None (precisa de upload TP)."""
        self.assertIsNone(_compute_credit_spread('IPCA', 10.5, 3.5, {}))
        self.assertIsNone(_compute_credit_spread('PRE',  15.0, 4.0, {}))

    def test_spread_inputs_invalidos(self):
        self.assertIsNone(_compute_credit_spread(None, 10, 3, {}))
        self.assertIsNone(_compute_credit_spread('IPCA', None, 3, {}))


class TestCouponSchedule(unittest.TestCase):
    """Cronograma de eventos (juros + amortização) forward/backward."""

    import datetime as _dt
    TODAY = _dt.date(2026, 5, 7)

    def test_norm_freq(self):
        self.assertEqual(_norm_freq('Mensal'), 'MENSAL')
        self.assertEqual(_norm_freq('semestral'), 'SEMESTRAL')
        self.assertEqual(_norm_freq('Anual'), 'ANUAL')
        self.assertIsNone(_norm_freq('Vencimento'))   # zero-coupon
        self.assertIsNone(_norm_freq(''))
        self.assertIsNone(_norm_freq(None))

    def test_parse_date_any(self):
        import datetime as _dt
        self.assertEqual(_parse_date_any('15/05/2030'), _dt.date(2030, 5, 15))
        self.assertEqual(_parse_date_any('15/05/30'),    _dt.date(2030, 5, 15))
        self.assertEqual(_parse_date_any('2030-05-15'),  _dt.date(2030, 5, 15))
        self.assertIsNone(_parse_date_any(''))
        self.assertIsNone(_parse_date_any(None))
        self.assertIsNone(_parse_date_any('abc'))

    def test_add_months_basic(self):
        import datetime as _dt
        self.assertEqual(_add_months(_dt.date(2026, 5, 15), 6),  _dt.date(2026, 11, 15))
        self.assertEqual(_add_months(_dt.date(2026, 5, 15), 12), _dt.date(2027, 5, 15))
        # Backward
        self.assertEqual(_add_months(_dt.date(2026, 5, 15), -6), _dt.date(2025, 11, 15))

    def test_add_months_clipping(self):
        """31/01 + 1 mês = 28/02 ou 29/02 (último dia do mês destino)"""
        import datetime as _dt
        self.assertEqual(_add_months(_dt.date(2026, 1, 31), 1), _dt.date(2026, 2, 28))
        self.assertEqual(_add_months(_dt.date(2024, 1, 31), 1), _dt.date(2024, 2, 29))   # bissexto

    def test_forward_catalogo_semestral_anual(self):
        """Catálogo XP: tem Primeira Data Juros → forward. CRI MULTIPLAN típico."""
        import datetime as _dt
        row = {
            'vencimento':            _dt.date(2029, 5, 17),
            'juros':                 'Semestral',
            'amortizacao':           'Anual',
            'primeira_data_juros':   _dt.date(2024, 11, 20),
        }
        sched = _coupon_schedule(row, today=self.TODAY)
        # Deve ter eventos futuros: 5 juros (20/05, 20/11 × 3) + amortizações no vcto (17/05/anos)
        self.assertGreater(len(sched), 5)
        # Primeiro evento deve ser >= today
        first_date = _dt.date(*[int(x) for x in sched[0]['date_iso'].split('-')])
        self.assertGreaterEqual(first_date, self.TODAY)
        # Juros forward: deve aparecer 20/05/2026
        juros_dates = [e['date'] for e in sched if e['tipo'] in ('juros','ambos')]
        self.assertIn('20/05/2026', juros_dates)

    def test_backward_mercado_sem_primeira_data(self):
        """Mercado: sem Primeira Data Juros → backward do vencimento."""
        import datetime as _dt
        row = {
            'vencimento':   '15/10/36',
            'juros':        'Semestral',
            'amortizacao':  'Anual',
        }
        sched = _coupon_schedule(row, today=self.TODAY)
        # Semestral backward: 15/04 e 15/10
        juros_dates = [e['date'] for e in sched if e['tipo'] in ('juros','ambos')]
        # Como amort = Anual no vcto (15/10), todo 15/10 vira 'ambos'
        all_dates = [e['date'] for e in sched]
        self.assertIn('15/04/2027', all_dates)
        self.assertIn('15/10/2027', all_dates)

    def test_zero_coupon_vencimento_vencimento(self):
        """Juros='Vencimento' + Amort='Vencimento' → 1 só evento no vcto."""
        import datetime as _dt
        row = {
            'vencimento':  _dt.date(2034, 7, 25),
            'juros':       'Vencimento',
            'amortizacao': 'Vencimento',
        }
        sched = _coupon_schedule(row, today=self.TODAY)
        self.assertEqual(len(sched), 1)
        self.assertEqual(sched[0]['date'], '25/07/2034')
        self.assertEqual(sched[0]['tipo'], 'ambos')
        self.assertEqual(sched[0]['source'], 'maturity')

    def test_papel_vencido(self):
        """Papel já vencido → nenhum evento futuro."""
        import datetime as _dt
        row = {
            'vencimento':  _dt.date(2020, 1, 1),
            'juros':       'Semestral',
            'amortizacao': 'Anual',
            'primeira_data_juros': _dt.date(2018, 7, 1),
        }
        sched = _coupon_schedule(row, today=self.TODAY)
        self.assertEqual(sched, [])

    def test_sem_vencimento_retorna_vazio(self):
        sched = _coupon_schedule({'juros': 'Semestral'}, today=self.TODAY)
        self.assertEqual(sched, [])


if __name__ == '__main__':
    unittest.main()
