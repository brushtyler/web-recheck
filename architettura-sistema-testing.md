# Architettura proposta per il testing automatico UI di siti diversi

Questo documento descrive il modello generale, i contratti tra componenti e le scelte tecniche proposte. Cataloghi dei testcase, inventari, route, fixture e requisiti di business dei singoli siti appartengono alle rispettive sottodirectory e non definiscono il comportamento del sistema generale.

## Obiettivo e limite della discovery automatica

Un crawler del DOM può scoprire pagine, link, pulsanti, form e stati visibili. Il codice sorgente e le richieste di rete aiutano a ipotizzare cosa facciano. Nessuno dei due determina in modo affidabile l'intenzione di business: l'**oracle** del risultato atteso resta una specifica verificabile, approvata o derivata da un contratto esplicito. Il sistema deve distinguere `DISCOVERED`, `INFERRED`, `APPROVED`, `EXECUTABLE` e `NEEDS_SPEC`, registrando la fonte e la confidenza. Non deve promuovere automaticamente un'ipotesi a requisito.

## Esito della revisione del 2026-11-06

Il piano è valido come architettura preliminare. L'esecuzione periodica con gate richiede prima la validazione di un set pilota, fixture ripetibili e risultati attesi approvati. Le regole operative seguenti sono una proposta di implementazione; la revisione documentale non costituisce esecuzione dei test né approvazione dei requisiti di business.

## Ruolo di Playwright e scelta del motore browser

**Si raccomanda Playwright per la prima implementazione dei test UI**, mantenendolo sostituibile tramite un adapter. È una proposta tecnica, non un vincolo dei formati di caso e risultato. Per eseguire test UI serve un motore che controlli un browser reale; per i soli test API o DB il browser non è necessario.

Playwright fornisce le API di automazione del browser. Playwright Test aggiunge runner, assertion, isolamento dei contesti e parallelizzazione, con supporto per Chromium, Firefox e WebKit. Le assertion web possono attendere una condizione osservabile; le trace permettono di ricostruire le azioni eseguite. Queste capacità coprono esigenze del piano senza dover costruire da zero un runner browser. Fonti: [introduzione](https://playwright.dev/docs/intro), [assertion](https://playwright.dev/docs/test-assertions), [Trace Viewer](https://playwright.dev/docs/trace-viewer-intro).

| Responsabilità | Impiego previsto di Playwright | Parte da implementare nel sistema |
|---|---|---|
| Esplorazione del sito | Aprire pagine, leggere DOM e controlli, interagire con form e menu | Strategia di esplorazione, grafo degli stati, deduplica, limiti e policy delle azioni |
| Esecuzione UI | Navigazione, click, input, attese, sessioni e assertion | Adapter del sito, passi approvati, collegamento tra caso e funzioni di test |
| Evidenze | Screenshot, trace, eventi console e rete | Redazione, conservazione, manifest e correlazione con casi e tentativi |
| Verifica del risultato | Eseguire le assertion definite | Specificare il risultato atteso di business e scegliere verifiche indipendenti |
| Fixture e decisione di rilascio | Fornire hook di setup/teardown e risultati dei test | Provisioning/reset dei dati, diagnosi, comparabilità storica e gate |

La discovery automatica richiede quindi un crawler da sviluppare sopra le API del browser. Playwright non stabilisce da solo quale comportamento di business sia corretto. Le verifiche DB richiedono un adapter dedicato; i controlli API possono essere eseguiti anche senza attraversare la UI.

Il contratto dell'adapter espone preparazione, esecuzione, raccolta delle evidenze e cleanup. Registry, scheduler, history e gate consumano il formato comune di risultato senza dipendere da oggetti Playwright. Gli adapter UI del primo rilascio possono usare TypeScript e Playwright Test; l'eventuale sostituzione del motore cambia gli adapter, preservando i contratti dei dati. La versione del motore resta registrata per la riproducibilità e il confronto delle run.

## Componenti

1. **Site profile** (YAML/JSON versionato): URL e ambienti, percorsi consentiti, ruolo/contesto, metodo di login, fixture, permessi, limiti di navigazione, policy per email/file/servizi esterni, configurazione di reset, azioni proibite, mascheramento dati. Nessuna credenziale nel repo: secret manager.
2. **Discovery runtime** (adapter browser, Playwright proposto): esplora per ruolo e stato iniziale; usa URL canonici, elementi accessibili, form, tab, dialog, menu e azioni condizionali; salva grafo `state -> action -> state`, etichette, attributi, screenshot e tracce. Deduplica per fingerprint semantico basato su route template, ruolo, stato, nome accessibile, destinazione e comportamento, con revisione dei casi ambigui. Limiti su profondità, cicli, paginazione e query string.
3. **Arricchimento facoltativo**: parser statico per siti con sorgente, OpenAPI/contratti, test esistenti e documentazione. Mappa i candidati a handler/API e segnala divergenze. Per siti senza sorgente resta possibile il solo black box.
4. **Case registry**: testcase versionati e revisionati, con prerequisiti, fixture, passi, oracle, cleanup, priorità, owner, rischio, fonte e stato di approvazione. L'AI può proporre descrizioni e possibili oracle, ma una persona deve approvare i casi di business ambigui prima del gate.
5. **Fixture manager**: crea dati isolati per run, shard, worker, caso e tentativo; snapshot/reset o cleanup idempotente; clock controllabile quando serve; account e sessioni separati per worker quando si modifica stato condiviso; tenant e stub per dipendenze esterne. Registra proprietario e risorse di ogni fixture. Se il reset non è affidabile, non ripetere mutazioni sullo stesso record.
6. **Executor** (adapter di esecuzione, Playwright Test proposto per la UI): esegue casi approvati in shard isolati. Selettori per ruolo/nome accessibile e `data-testid` solo quando necessario. Attese su condizioni osservabili, non sleep fissi; retry soltanto per diagnosi di flakiness, mai per trasformare un fallimento in PASS silenzioso. Raccoglie trace, screenshot, console, network e controlli API/DB mirati.
7. **Oracle engine**: verifica UI, navigazione, risposta API, persistenza, isolamento dati, audit e file secondo ciascun caso. Controlla anche invarianti trasversali: nessun errore console rilevante, nessun 5xx, accesso negato dove dovuto, idempotenza, duplicati, regressioni visive solo su aree stabili.
8. **Triage**: collega il primo sintomo alla causa probabile usando evidenze. Classi: `BUG_APP`, `ENV_DB_TIMEOUT`, `ENV_SERVICE`, `AUTH_FIXTURE`, `TEST_FLAKY`, `SPEC_GAP`, `DATA_DRIFT`, `UNKNOWN`. Le classi sono ipotesi con confidenza; BUG richiede riproduzione o prova forte. Conservare `FAIL` distinto dalla causa.
9. **Report e history store**: salva manifest immutabile della run, risultati, artefatti, versione sito/commit, versione test, ambiente e fixture. Genera HTML leggibile, JSON per API e JUnit per CI. Pseudonimizza o redige dati personali, token, cookie, file.
10. **Scheduler + gate**: run periodiche e on demand; lock sulle risorse condivise tra worker e run, incluse impostazioni globali e operazioni platform; timeout globale; allarmi. Il gate valuta gli esiti correnti anche senza baseline. Il confronto storico usa una configurazione comparabile esplicita; gli altri confronti sono `NOT_COMPARABLE`, senza essere conteggiati come miglioramenti/regressioni.

## Flusso operativo

`site profile -> discovery -> review dei candidati -> case registry -> provisioning fixture -> run -> evidenze -> oracle -> triage -> report -> gate -> confronto con baseline`

La discovery è separata dall'esecuzione periodica: una scansione quotidiana può rilevare nuovi controlli, ma solo i casi approvati entrano nella suite con gate. Le azioni read only possono essere esplorate più liberamente. Le azioni di scrittura vanno eseguite su ambiente e dati isolati secondo la policy del site profile; i controlli con effetti esterni devono usare integrazioni sandbox.

## Contratto di esecuzione e schema minimo

Per il primo rilascio UI si propone un registry di funzioni TypeScript basate su Playwright Test, collegate attraverso l’adapter di esecuzione, con identificatori espliciti. `executor_id`, `fixture_id` e gli ID delle verifiche risolvono solo adapter registrati nel codice versionato. Passi e risultati attesi in prosa documentano il caso; l'executor non li interpreta come istruzioni eseguibili e non carica codice indicato liberamente dal YAML. Un linguaggio dichiarativo più generale potrà essere valutato dopo il pilota.

Lo schema validabile deve separare **definizione versionata del caso**, **manifest della suite** e **risultati immutabili della run**. Il manifest elenca in anticipo casi, revisioni, parametri e casi obbligatori: il gate deve rilevare anche risultati mancanti. I valori concreti e gli esempi dei testcase sono documentati nei dossier dei singoli siti.

| Campi della definizione del caso | Significato e vincolo |
|---|---|
| `schema_version`, `id`, `revision`, `site_id` | Versione del formato e identità stabile del caso nel sito |
| `area`, `route_template`, `role`, `context_profile` | Ambito UI e profilo di autorizzazione, senza credenziali |
| `fixture_id`, `fixture_version`, `preconditions` | Stato iniziale richiesto e provisioning riproducibile |
| `executor_id`, `executor_version`, `cleanup_id` | Binding a codice registrato e versionato per esecuzione e ripristino |
| `steps`, `expected` | Descrizioni dei passi e degli esiti; ogni verifica ha un ID collegato a un'assertion concreta |
| `priority`, `required`, `owner`, `risk` | Priorità, obbligatorietà nel gate, responsabilità e tipo di effetto |
| `status`, `approval`, `source`, `confidence` | Stato di review, approvazione della revisione e provenienza dell'oracle |

Audit, notifiche e altri oracle entrano nel caso con verifiche concrete solo quando il contratto ne stabilisce obbligatorietà e contenuto. Lo stato `EXECUTABLE` richiede approvazione valida per la revisione corrente, owner, fixture e cleanup disponibili, binding di tutte le verifiche, e policy dell'ambiente soddisfatta. Un binding mancante blocca il caso; nessuna verifica viene ignorata silenziosamente.

Il record di risultato contiene almeno `run_id`, `case_id`, `case_revision`, parametri, timestamp, build/commit, versione executor, configurazione comparabile, durata, tentativi, risorse fixture, artefatti, `observed` per ogni oracle, verdetto, failure signature, classificazione/confidenza, note e issue associata. Conservare il confronto puntuale con l'atteso e tutti i tentativi. Il risultato non modifica la definizione del caso.

Il vocabolario canonico del verdetto è `NON_ESEGUITO`, `PASS`, `FAIL`, `BLOCKED`, `SKIPPED`, `INCONCLUSIVE`. Eventuali import legacy con `NOT_RUN` sono normalizzati a `NON_ESEGUITO`. Gli stati di review (`NEEDS_SPEC`, ecc.), la diagnosi (`BUG_APP`, `UNKNOWN`, ecc.) e la comparabilità sono campi separati. Un tentativo fallito seguito da uno riuscito imposta anche `flaky: true`; il PASS dell'ultimo tentativo non cancella il primo esito.

## Isolamento di fixture, worker e retry

- Ogni risorsa creata ha un proprietario identificato da `run_id + shard_id + worker_id + case_id + attempt`. Account, sessioni e dati mutabili non vengono condivisi tra worker concorrenti, salvo un lock esplicito. La sola separazione dei browser context non isola lo stato del backend.
- La classe/versione della fixture descrive lo stato riproducibile; UUID e nomi casuali identificano le istanze. Tenant fisici diversi possono essere equivalenti solo con una mappatura esplicita del profilo e delle autorizzazioni. Isolare o serializzare anche modifiche alle impostazioni del tenant e della piattaforma.
- Prima di ogni retry, acquisire le evidenze e ricreare la fixture o verificarne il ripristino allo stato iniziale. Se lo stato è ignoto o il cleanup fallisce, bloccare il retry, mettere in quarantena le risorse e segnalare il problema; non ripetere l'azione sul record già modificato.
- Cleanup idempotente limitato alle risorse possedute, teardown e recupero dopo interruzioni devono essere verificabili. Un errore di cleanup resta nel report e impedisce di riusare le risorse contaminate.

Il modello con account separati per worker nei test che modificano stato condiviso è coerente con la [documentazione di autenticazione Playwright](https://playwright.dev/docs/auth#moderate-one-account-per-parallel-worker). Anche i [retry Playwright](https://playwright.dev/docs/test-retries) distinguono i test riusciti al primo tentativo da quelli riusciti dopo un fallimento.

## Report, comparabilità e gate

Per ogni run: manifest, copertura per modulo/ruolo rispetto ai casi pianificati, conteggi per tutti i verdetti, tempi, errori di infrastruttura e cleanup, risultati con prerequisiti/atteso/ottenuto/evidenze, raggruppamento per firma del problema, issue suggerite e confronto con la baseline. I dati personali non devono comparire in report o artefatti condivisi.

### Configurazione comparabile

La chiave di confronto di un risultato è `site_id + case_id + case_revision + parameter_set + comparison_config_id`. `comparison_config_id` è l'hash di una configurazione canonica che include ambiente, versione del site profile, contesto personale/tenant/platform, tenant logico o mappatura di equivalenza, ruolo e capability effettive, classe/versione fixture, versione executor e motore di esecuzione, browser, locale, timezone, modalità dei servizi esterni e versione della policy di gate. Gli ID casuali delle istanze fixture, i timestamp della run e la build del prodotto sotto test sono registrati nel manifest ma esclusi dall'hash: il confronto serve anche a valutare build diverse.

Il report distingue nuovi fallimenti, persistenti, risolti, regressioni (`PASS -> FAIL`), flakiness e casi nuovi/rimossi. Una modifica del requisito o del testcase cambia revisione e richiede una mappatura esplicita; non è un problema risolto. Una configurazione differente o una baseline assente produce un confronto `NOT_COMPARABLE` con motivazione. Questo non sospende la valutazione dell'esito corrente da parte del gate.

### Matrice proposta per il gate

La policy deve essere versionata e approvata dal proprietario prima dell'uso per un rilascio. I casi P0/P1 sono obbligatori per default; la severità di un finding è distinta dalla priorità del testcase. La proposta iniziale non tollera fallimenti applicativi privi di deroga né casi obbligatori senza esito affidabile.

| Condizione corrente senza deroga valida | Gate proposto |
|---|---|
| `FAIL` con `BUG_APP`, incluso difetto critico già noto, nuovo caso senza baseline o regressione | `FAIL` |
| Fallimento con diagnosi `UNKNOWN` o evidenze insufficienti | `INCONCLUSIVE` |
| Caso obbligatorio `BLOCKED`, `SKIPPED`, `NON_ESEGUITO`, `INCONCLUSIVE`, assente dal risultato o non più eseguibile | `INCONCLUSIVE` |
| Caso obbligatorio riuscito solo dopo retry, con `flaky: true` | `INCONCLUSIVE` |
| Ambiente/fixture non affidabili, cleanup fallito o isolamento non dimostrato | `INCONCLUSIVE` |
| Risultati non obbligatori incompleti o flaky oltre le soglie della policy | `INCONCLUSIVE` |
| Policy mancante/non approvata, manifest incoerente o configurazione non validata | `INCONCLUSIVE` |
| Tutti i casi obbligatori PASS al primo tentativo, nessuna condizione precedente e soglie rispettate | `PASS` |

Precedenza: `FAIL` prevale su `INCONCLUSIVE`, che prevale su `PASS`. Le soglie per incompletezza e flakiness dei casi non obbligatori sono zero nella proposta iniziale; ogni tolleranza diversa deve essere esplicita nella policy. Un requisito senza specifica non può essere escluso tacitamente dalla suite obbligatoria. Le deroghe riportano owner autorizzato, motivazione, finding/casi e ambiente interessati, revisione, scadenza e accettazione del rischio. Sono visibili nel report e non riscrivono i risultati grezzi.

## Roadmap per il nuovo repository

1. **Contratti e prerequisiti:** definire e validare gli schemi di site profile, caso, manifest, risultato, finding e policy. Importare l'inventario come candidati non approvati; assegnare priorità e owner ai casi pilota. Confermare provisioning, credenziali di test, integrazioni sandbox e reset.
2. **Pilota prima della discovery generale:** implementare 10–20 casi definiti e approvati individualmente, con binding Playwright, fixture ripetibili e report minimo JSON/HTML. Selezionare per il sito pilota accesso, autorizzazioni, navigazione e flussi di lettura/scrittura prioritari; la selezione concreta appartiene al dossier del sito. Separare i test UI con API simulate dai test integrati con backend reale; i primi non provano la persistenza.
3. **Criteri di uscita del pilota:** ogni caso deve avere risultato atteso verificabile ed evidenze; almeno tre run consecutive da fixture ripristinate devono produrre esiti coerenti. Verificare anche che una violazione nota dell'oracle venga rilevata, che un caso obbligatorio mancante impedisca il verde e che retry/cleanup non contaminino la run. Usare eventuali test e contratti esistenti del sito pilota come riferimento, senza promuoverne assunzioni non verificate.
4. **Discovery e riconciliazione:** aggiungere l'esplorazione per ruolo/contesto, grafo degli stati, associazione dei componenti alle pagine, diff e queue `NEEDS_SPEC`. Revisionare anche i candidati senza quel marcatore; nessuna promozione automatica a caso approvato.
5. **Operatività:** aggiungere scheduler, history store, JUnit, baseline comparabili e gate secondo la matrice approvata; verificare lock e recupero dopo interruzioni.
6. **Nuovi siti:** estendere gli adapter di autenticazione, fixture e oracle dopo la validazione del pilota; misurare copertura su route/stati/ruoli/azioni, durata delle run e tempo di triage.

## Rischi da governare

- **Copertura apparente:** Il numero di route e candidati statici non equivale a scenari testati né a una misura della copertura funzionale. Servono combinazioni di ruolo, stato e dati, con un limite pratico definito dalle priorità.
- **Oracle deboli:** click riuscito o toast mostrato non dimostrano che la funzione sia corretta. Usare verifiche indipendenti quando possibile.
- **Flakiness:** rete, servizi esterni, date, animazioni e dati condivisi producono falsi BUG; isolare fixture e preservare trace.
- **Sicurezza e privacy:** il crawler deve rispettare allowlist di host e tenant, rate limit, redazione dei segreti e policy di scrittura; evitare esplorazione cieca di azioni di cancellazione/revoca.
