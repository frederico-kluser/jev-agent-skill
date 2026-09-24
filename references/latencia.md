# Latência — porquê keep-alive, batching e MCP residente

A promessa do System One é decisão em ~70-500 ms. Mas a latência sentida é
`inferência + rede + arranque de processo`. Esta skill ataca os dois últimos.

## O imposto do processo efémero

Cada invocação CLI paga arranque do Node (~30-60 ms) e, se o socket não estiver
quente, o handshake completo contra o endpoint:

| Componente | Custo típico |
|---|---|
| Resolução DNS | ~1 RTT (0 se em cache) |
| Handshake TCP (SYN/ACK) | 1 RTT |
| Handshake TLS 1.3 | 1 RTT |
| Request/Response HTTP | 1 RTT |
| Inferência Jev | ~70-500 ms |

Com socket **frio**, 3 RTT extra somam-se a cada decisão. Com `keepAlive` num
processo residente (MCP `serve`) ou num `batch` sequencial, só a 1ª chamada paga
os handshakes; as seguintes reutilizam o canal TLS (`req.reusedSocket = true`).

## Medições reais desta skill (2026-09-24, rede desta máquina)

```
ask isolado (processo + socket frios)      ~330 ms de latência total
batch 5 decisões, 1 processo, sequencial   #0 327 ms (frio) → #1-#4 ~260-330 ms
                                            sockets_warm = 4/5 ✓
batch 5 decisões, concurrency 5 (paralelo) máx 361 ms — sockets novos em paralelo
MCP serve (processo residente)             1ª decisão fria, seguintes quentes
```

Conclusões medidas:
- **Warm socket funciona** (4/5 reutilizados em sequencial; o pool mantém o TLS).
- O ganho por decisão é modesto nesta rede (~30-70 ms) porque o RTT ao endpoint
  domina; em ligações com RTT alto (ex.: América do Sul → US-East, ~110-130 ms
  citados em análises de rede) o ganho do keep-alive é de ~2-3 RTT (~250-400 ms).
- Processo Node efémero custa ~30-60 ms — irrelevante isolado, relevante em
  centenas de decisões.

## Receitas de velocidade

1. **Rajadas → `batch`** (1 processo, N decisões). Concorrência alta = sockets
  novos; para máxima reutilização use `--concurrency 1`..`4`.
2. **Loops de agente → MCP `serve`**. O servidor fica residente e o pool de
  sockets sobrevive entre decisões: cada decisão paga ~1 RTT + inferência.
3. **Muitas perguntas → 1 chamada**. As perguntas são avaliadas EM PARALELO sobre
  o mesmo `state` (ingerido uma vez): 13 perguntas num pedido mediram-se como
  ~11,5× mais baratas e ~9,6× mais rápidas que 13 chamadas separadas (cookbooks
  TypeSafe). Agrupar julgamentos independentes é SEMPRE vantajoso.
4. **Não repita contexto**: perguntas no mesmo mapa partilham o `state`; se duas
  decisões precisam do mesmo contexto, são uma chamada só.
5. **Falhe rápido**: erros terminais (400/401/402/404/413/422) nunca são
  repetidos; só 429/5xx/redes levam backoff exponencial com `Retry-After`
  (250 ms → 500 ms → 1 s + jitter).

## Modelo de custo-latência por modo

| Modo | Latência por decisão | Arranque | Ideal para |
|---|---|---|---|
| `ask` isolado | ~300 ms (frio) | por decisão | decisões avulsas |
| `batch` sequencial | ~260-330 ms (quente após 1ª) | 1× | triagem em massa |
| `batch` paralelo | ~300 ms, N em simultâneo | 1× | throughput máximo |
| `serve` (MCP) | ~1 RTT + inferência | 1× por sessão | loops de agente/tempo real |

## Referências

- `references/api.md` §Limites — rate limits (250k tok/s, 1.200 rpm) e preço.
- O relatório de arquitetura que originou esta skill citava RTT São Paulo↔US-East
  de 110-130 ms (cabos Monet/Seabras-1/BRUSA) e ~480 ms de imposto de handshake
  em scripts efémeros — coerente com as medições acima, mas os números de rede
  variam por rota/ISP; valide com `batch --concurrency 1` na sua rede.
