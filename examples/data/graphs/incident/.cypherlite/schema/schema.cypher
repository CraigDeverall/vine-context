CREATE VECTOR INDEX `search_embedding` FOR (n:`Claim`|`Question`) ON (n.`embedding`) OPTIONS {indexConfig: {`vector.default_search_expansion_factor`: 3.0,`vector.dimensions`: 256,`vector.hnsw.ef_construction`: 100,`vector.hnsw.m`: 16,`vector.quantization.type`: 'BINARY',`vector.similarity_function`: 'COSINE'}};
CREATE FULLTEXT INDEX `search_text` FOR (n:`Claim`|`Question`) ON EACH [n.`text`] OPTIONS {indexConfig: {`fulltext.analyzer`: 'standard-no-stop-words',`fulltext.eventually_consistent`: false}};
CREATE CONSTRAINT `claim_id_key` FOR (n:`Claim`) REQUIRE (n.`id`) IS UNIQUE;
CREATE CONSTRAINT `question_id_key` FOR (n:`Question`) REQUIRE (n.`id`) IS UNIQUE;
