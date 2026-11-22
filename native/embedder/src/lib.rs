// A sentence-embedding model run in pure Rust (tract, no onnxruntime), exposed
// to Node as a synchronous call so it fits the `Embedder` interface in
// src/core/embed.ts.

use std::path::Path;

use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokenizers::{Tokenizer, TruncationParams};
use tract_onnx::prelude::*;

#[napi]
pub struct Model {
    tokenizer: Tokenizer,
    plan: Arc<TypedRunnableModel>,
    /// The model's input names, in the order it expects them.
    inputs: Vec<String>,
    /// true averages all tokens (MiniLM); false takes the first token's vector (bge).
    mean_pooling: bool,
}

fn err<E: std::fmt::Display>(e: E) -> Error {
    Error::from_reason(e.to_string())
}

#[napi]
impl Model {
    /// Loads `tokenizer.json` and the ONNX file `model_file` from `dir`.
    /// `pooling` is "cls" or "mean". Longer texts are cut at `max_tokens`.
    #[napi(constructor)]
    pub fn new(dir: String, model_file: String, pooling: String, max_tokens: u32) -> Result<Self> {
        if pooling != "cls" && pooling != "mean" {
            return Err(Error::from_reason(format!("pooling must be 'cls' or 'mean', not '{pooling}'")));
        }
        let dir = Path::new(&dir);
        let mut tokenizer = Tokenizer::from_file(dir.join("tokenizer.json")).map_err(err)?;
        tokenizer
            .with_truncation(Some(TruncationParams { max_length: max_tokens as usize, ..Default::default() }))
            .map_err(err)?;
        tokenizer.with_padding(None);

        let model = tract_onnx::onnx().model_for_path(dir.join(&model_file)).map_err(err)?;
        let inputs: Vec<String> = model
            .input_outlets()
            .map_err(err)?
            .iter()
            .map(|o| model.node(o.node).name.clone())
            .collect();
        let plan = model.into_optimized().map_err(err)?.into_runnable().map_err(err)?;
        Ok(Model { tokenizer, plan, inputs, mean_pooling: pooling == "mean" })
    }

    /// A unit-length embedding of `text`.
    #[napi]
    pub fn embed(&self, text: String) -> Result<Float32Array> {
        let enc = self.tokenizer.encode(text, true).map_err(err)?;
        let n = enc.get_ids().len();
        let row = |v: Vec<i64>| -> Result<TValue> {
            Ok(tract_ndarray::Array2::from_shape_vec((1, n), v).map_err(err)?.into_tensor().into())
        };
        let mut feed: TVec<TValue> = tvec!();
        for name in &self.inputs {
            let v: Vec<i64> = match name.as_str() {
                "input_ids" => enc.get_ids().iter().map(|&x| x as i64).collect(),
                "attention_mask" => vec![1; n],
                "token_type_ids" => vec![0; n],
                other => return Err(Error::from_reason(format!("unexpected model input '{other}'"))),
            };
            feed.push(row(v)?);
        }

        let out = self.plan.run(feed).map_err(err)?;
        let hidden = out[0].to_plain_array_view::<f32>().map_err(err)?; // [1, tokens, dim]
        let dim = hidden.shape()[2];
        let mut vec = vec![0f32; dim];
        if self.mean_pooling {
            for t in 0..n {
                for (d, v) in vec.iter_mut().enumerate() {
                    *v += hidden[[0, t, d]];
                }
            }
        } else {
            for (d, v) in vec.iter_mut().enumerate() {
                *v = hidden[[0, 0, d]];
            }
        }
        let norm = vec.iter().map(|v| v * v).sum::<f32>().sqrt();
        if norm > 0.0 {
            vec.iter_mut().for_each(|v| *v /= norm);
        }
        Ok(Float32Array::new(vec))
    }

    /// How many tokens the tokenizer makes of `text`, after truncation.
    #[napi]
    pub fn token_count(&self, text: String) -> Result<u32> {
        Ok(self.tokenizer.encode(text, true).map_err(err)?.get_ids().len() as u32)
    }
}
