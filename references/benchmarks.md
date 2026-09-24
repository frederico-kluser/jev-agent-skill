# Benchmarks — antes/depois e decisões medidas

Tudo medido com `node scripts/bench.mjs` (offline) e `--live` (chamadas reais à
Decisions API), Node v24.19.0, rede desta máquina, 2026-09-24. Reproduzir:

```bash
node scripts/bench.mjs                # arranque + validação + selftest
node scripts/bench.mjs --live         # + latência real h1 vs h2 (~110 chamadas)
```

## 1. Antes → depois das melhorias de implementação

| Métrica | Antes | Depois | Δ |
|---|---|---|---|
| Arranque da CLI (p50, `help`) | 38 ms | 26 ms | **−29%** (lazy-import de `client`/`readline`) |
| `validate` — pedido pequeno | 242k ops/s | 247k ops/s | ≈ par (já era irrelevante) |
| `validate` — pedido 40 KB | 1,8k ops/s | 1,8k ops/s | ≈ par (0,55 ms/validação) |
| `eval` 8 casos (parede) | ~2.400 ms (sequencial) | 670–1.700 ms (concorrência 4) | **−30…70%** |
| `selftest` | 29 casos / 376 ms | 36 casos / 480 ms | +7 casos (inclui servidor h2 local) |
| Decisão isolada (quente) | ~290–330 ms | ~300 ms (p50) | par — limitada por RTT+inferência |

A validação pesada custa **<1 µs por pedido** — pode (e deve) correr sempre.

## 2. Estudo de transporte: h1 keep-alive vs h2 multiplexado

Hipótese: HTTP/2 (1 canal TLS, N streams) venceria em rajadas. **Medido contra o
endpoint real, a hipótese não se confirma para latência** — e o padrão foi
invertido para `h1` com base nos dados:

**Rajada fria de 8 decisões** (ligações recriadas de raiz, rondas pareadas):

| Ronda | h1 (wall · latências por pedido) | h2 (wall · latências por pedido) |
|---|---|---|
| 1 | 939 ms · `[310,313,313,340,366,393,408,918]` | 1258 ms · `[325,328,750,843,848,895,1248,1255]` |
| 2 | 1265 ms · `[303,303,306,318,328,343,426,1262]` | 1185 ms · `[289,315,326,1163,1179,1179,1179,1184]` |

- **h1 entrega ~6/8 pedidos em ≤430 ms**; h2 concentra a cauda (2-3/8 rápidos,
  o resto em ondas ~1180 ms) — bloqueio de cabeça de linha: N streams partilham
  UM cwnd TCP, enquanto h1 dá um socket/cwnd por pedido.
- Sequencial quente: paridade (p50 h1 305 ms vs h2 282-310 ms) — limitado por RTT.
- O ganho do h2 é de **recursos** (1 canal TLS vs N sockets), não de wall-time
  nesta rede. Fica como opção `JEV_TRANSPORT=h2` para ligações muito limitadas
  em sockets ou uso sequencial pesado (MCP residente).

Conclusão aplicada: **default `h1`** (keep-alive), `h2`/`auto` disponíveis.

## 3. Bugs encontrados PELA medição (o valor de medir)

1. **`sock.reused` não existe em `TLSSocket`** → telemetria de socket quente
   sempre falsa. Correção: `req.reusedSocket`. (anterior sessão)
2. **Leak de sessão h2 por evento `close` tardio**: o handler apagava a entrada
   do mapa SEM verificar se ainda era a mesma sessão — o `close` de uma sessão
   antiga removia a entrada da NOVA. Sintoma: processo que nunca termina
   (event loop preso em sockets vivos). Correção: evição condicional por
   identidade + regressão offline com servidor h2 local no selftest.
3. **Falso positivo do lint jaggedness** (`conte` ⊂ `content`) — apanhado pelos
   testes de injeção, travado no selftest.

## 4. O que se decidiu NÃO fazer (anti-overenginier)

| Ideia descartada | Porquê |
|---|---|
| V8 startup snapshots / compilação AOT | −5 ms hipotéticos vs complexidade de build; o lazy-import cobriu 29% do arranque |
| `undici` como dependência | precisa de npm install (quebra zero-deps) para ganho não medido vs `node:https` |
| Pool de workers / cache de respostas | decisões são baratas ($0.00002) e mudam com o state; cache só traria risco de decisão velha |
| Mais primitivas de pergunta | o modelo tem 3; validar mais que isso seria inventar |
| Retry adaptativo/complexo | backoff exponencial + `Retry-After` com cap cobre os casos documentados |
