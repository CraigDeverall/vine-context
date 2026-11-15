CREATE VECTOR INDEX `search_embedding` FOR (n:`Decision`|`Option`|`Assumption`) ON (n.`embedding`) OPTIONS {indexConfig: {`vector.default_search_expansion_factor`: 3.0,`vector.dimensions`: 256,`vector.hnsw.ef_construction`: 100,`vector.hnsw.m`: 16,`vector.quantization.type`: 'BINARY',`vector.similarity_function`: 'COSINE'}};
CREATE FULLTEXT INDEX `search_text` FOR (n:`Decision`|`Option`|`Assumption`) ON EACH [n.`text`] OPTIONS {indexConfig: {`fulltext.analyzer`: 'standard-no-stop-words',`fulltext.eventually_consistent`: false}};
CREATE CONSTRAINT `assumption_id_key` FOR (n:`Assumption`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `decision_id_key` FOR (n:`Decision`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `option_id_key` FOR (n:`Option`) REQUIRE (n.`id`) IS UNIQUE;
