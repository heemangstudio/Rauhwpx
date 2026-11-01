//! 바이너리 데이터 (BinData, 이미지/OLE 참조)

/// 바이너리 데이터 아이템 (HWPTAG_BIN_DATA)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BinData {
    /// 원본 레코드 바이트 (라운드트립 보존용)
    pub raw_data: Option<Vec<u8>>,
    /// 속성 비트 플래그
    pub attr: u16,
    /// 데이터 타입
    pub data_type: BinDataType,
    /// 압축 방식
    pub compression: BinDataCompression,
    /// 접근 상태
    pub status: BinDataStatus,
    /// 연결 파일 절대 경로 (LINK 타입)
    pub abs_path: Option<String>,
    /// 연결 파일 상대 경로 (LINK 타입)
    pub rel_path: Option<String>,
    /// BinData 스토리지 내 ID (EMBEDDING/STORAGE 타입)
    pub storage_id: u16,
    /// 확장자 (EMBEDDING 타입: jpg, bmp, png 등)
    pub extension: Option<String>,
}

/// 바이너리 데이터 타입
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum BinDataType {
    #[default]
    /// 외부 파일 참조
    Link,
    /// 파일 포함
    Embedding,
    /// OLE 포함
    Storage,
}

/// 바이너리 데이터 압축 방식
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum BinDataCompression {
    #[default]
    /// 스토리지 디폴트
    Default,
    /// 무조건 압축
    Compress,
    /// 무조건 비압축
    NoCompress,
}

/// 바이너리 데이터 접근 상태
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub enum BinDataStatus {
    #[default]
    /// 아직 접근하지 않음
    NotAccessed,
    /// 접근 성공
    Success,
    /// 접근 실패
    Error,
    /// 접근 실패했으나 무시됨
    Ignored,
}

/// BinData 스토리지에서 로드된 실제 데이터
#[derive(Debug, Clone)]
pub struct BinDataContent {
    /// 스토리지 ID
    pub id: u16,
    /// 바이너리 데이터
    pub data: BinDataBytes,
    /// 파일 확장자
    pub extension: String,
}

impl BinDataContent {
    /// 순번 조회(`bin_data_id - 1`)를 맞추려고 비워 둔 자리인지.
    ///
    /// HWP3 파서는 연결(Link) 그림 자리를 id 0·빈 바이트로 채운다. 저장할 스트림이 아니므로
    /// 직렬화는 건너뛴다. 모두 `BIN0000.` 이름을 받아 저장이 중복 스트림으로 실패했다.
    pub fn is_position_placeholder(&self) -> bool {
        self.id == 0 && self.extension.is_empty() && self.data.is_empty()
    }
}

/// Encoding properties that must remain unchanged when an HWP5 BinData stream
/// is copied verbatim from its source container.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BinDataStreamEncoding {
    pub compressed: bool,
    pub ole_storage: bool,
}

/// Small, stable identity for a BinData payload.
///
/// The identity lets merge and manifest code compare or describe lazy payloads
/// without materializing them. `domain` distinguishes decoded bytes from exact
/// source-container streams so two different encodings cannot compare equal by
/// accident.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinDataPayloadIdentity {
    domain: String,
    byte_len: u64,
    digest: [u8; 32],
}

impl BinDataPayloadIdentity {
    pub fn new(domain: impl Into<String>, byte_len: u64, digest: [u8; 32]) -> Self {
        Self {
            domain: domain.into(),
            byte_len,
            digest,
        }
    }

    fn decoded(bytes: &[u8]) -> Self {
        Self::new(
            "decoded",
            bytes.len() as u64,
            *blake3::hash(bytes).as_bytes(),
        )
    }

    pub(crate) fn token(&self) -> String {
        format!(
            "{}:{}:blake3:{}",
            self.domain,
            self.byte_len,
            blake3::Hash::from_bytes(self.digest).to_hex()
        )
    }
}

/// 지연 로딩 대상 BinData 를 원본 컨테이너에서 다시 읽어오는 주체.
///
/// [Task #2263] 압축 해제된 이미지 바이트를 IR 에 상주시키지 않기 위해,
/// 원본 컨테이너(HWPX ZIP / HWP5 CFB)를 보유한 파서 측이 이 트레이트를
/// 구현하고, 실제 바이트가 필요한 시점에만 압축을 푼다.
pub trait BinDataResolver:
    std::fmt::Debug + Send + Sync + std::panic::RefUnwindSafe + std::panic::UnwindSafe
{
    /// `key` 가 가리키는 BinData 의 바이트를 압축 해제하여 반환한다.
    ///
    /// 원본이 손상되었거나 엔트리가 없으면 빈 벡터를 반환한다
    /// (파싱 시점의 placeholder 의미를 그대로 유지한다).
    fn resolve(&self, key: &str) -> Vec<u8>;

    /// 최대 `max_bytes` 바이트까지만 materialize하여 반환한다.
    ///
    /// 기본 구현은 안전하게 실패한다. 컨테이너별 리졸버가 압축 해제 경계에서
    /// 상한을 보장할 수 있을 때만 이 메서드를 구현해야 한다.
    fn resolve_limited(&self, _key: &str, _max_bytes: usize) -> Option<Vec<u8>> {
        None
    }

    /// Resolve to a shared immutable payload. Resolver wrappers may override
    /// this to deduplicate repeated source-key materializations.
    fn resolve_shared(&self, key: &str) -> std::sync::Arc<[u8]> {
        self.resolve(key).into()
    }

    /// Bounded counterpart to [`BinDataResolver::resolve_shared`].
    fn resolve_limited_shared(&self, key: &str, max_bytes: usize) -> Option<std::sync::Arc<[u8]>> {
        self.resolve_limited(key, max_bytes).map(Into::into)
    }

    /// Return the exact encoded source-container stream for fail-closed
    /// round-trip preservation when decoded materialization is unavailable.
    /// Resolvers must leave this unsupported when the source stream cannot be
    /// copied verbatim into the destination container format.
    fn resolve_original_stream_limited(
        &self,
        _key: &str,
        _expected_encoding: BinDataStreamEncoding,
        _max_bytes: usize,
    ) -> Option<Vec<u8>> {
        None
    }

    /// Return a bounded, stable payload identity without materializing the
    /// complete payload. Container resolvers should hash the source stream
    /// incrementally and include its representation in the identity domain.
    fn payload_identity(&self, _key: &str) -> Option<BinDataPayloadIdentity> {
        None
    }
}

#[derive(Debug, Default)]
pub struct BinDataPayloadCache {
    payloads: std::sync::Mutex<std::collections::HashMap<String, std::sync::Weak<[u8]>>>,
}

impl BinDataPayloadCache {
    /// Locks the map after dropping entries whose payload is gone. A `Weak<[u8]>`
    /// keeps the whole `Arc` allocation, payload bytes included, until the weak
    /// handle itself drops, so dead entries would pin every image ever rendered.
    fn live_payloads(
        &self,
    ) -> std::sync::MutexGuard<'_, std::collections::HashMap<String, std::sync::Weak<[u8]>>> {
        let mut cached = self
            .payloads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        cached.retain(|_, payload| payload.strong_count() > 0);
        cached
    }

    fn load(&self, resolver: &dyn BinDataResolver, key: &str) -> std::sync::Arc<[u8]> {
        let mut cached = self.live_payloads();
        if let Some(payload) = cached.get(key).and_then(std::sync::Weak::upgrade) {
            return payload;
        }
        let payload: std::sync::Arc<[u8]> = resolver.resolve(key).into();
        cached.insert(key.to_string(), std::sync::Arc::downgrade(&payload));
        payload
    }

    fn load_limited(
        &self,
        resolver: &dyn BinDataResolver,
        key: &str,
        max_bytes: usize,
    ) -> Option<std::sync::Arc<[u8]>> {
        let mut cached = self.live_payloads();
        if let Some(payload) = cached.get(key).and_then(std::sync::Weak::upgrade) {
            return (payload.len() <= max_bytes).then_some(payload);
        }
        let payload: std::sync::Arc<[u8]> = resolver.resolve_limited(key, max_bytes)?.into();
        if payload.len() > max_bytes {
            return None;
        }
        cached.insert(key.to_string(), std::sync::Arc::downgrade(&payload));
        Some(payload)
    }
}

/// Adds source-key scoped weak payload sharing to an existing resolver.
///
/// The wrapper is shared by every HWPX/HWP5 BinData entry in a document. It
/// serializes the first materialization of a key and returns the same `Arc` to
/// concurrent or duplicate references. Weak entries avoid pinning all images
/// after their render trees have been dropped.
#[derive(Debug)]
pub struct SharedBinDataResolver {
    inner: std::sync::Arc<dyn BinDataResolver>,
    cache: BinDataPayloadCache,
    identities: std::sync::Mutex<std::collections::HashMap<String, BinDataPayloadIdentity>>,
}

impl SharedBinDataResolver {
    pub fn new(inner: std::sync::Arc<dyn BinDataResolver>) -> Self {
        Self {
            inner,
            cache: BinDataPayloadCache::default(),
            identities: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

impl BinDataResolver for SharedBinDataResolver {
    fn resolve(&self, key: &str) -> Vec<u8> {
        self.cache.load(self.inner.as_ref(), key).as_ref().to_vec()
    }

    fn resolve_limited(&self, key: &str, max_bytes: usize) -> Option<Vec<u8>> {
        self.cache
            .load_limited(self.inner.as_ref(), key, max_bytes)
            .map(|payload| payload.as_ref().to_vec())
    }

    fn resolve_shared(&self, key: &str) -> std::sync::Arc<[u8]> {
        self.cache.load(self.inner.as_ref(), key)
    }

    fn resolve_limited_shared(&self, key: &str, max_bytes: usize) -> Option<std::sync::Arc<[u8]>> {
        self.cache.load_limited(self.inner.as_ref(), key, max_bytes)
    }

    fn resolve_original_stream_limited(
        &self,
        key: &str,
        expected_encoding: BinDataStreamEncoding,
        max_bytes: usize,
    ) -> Option<Vec<u8>> {
        self.inner
            .resolve_original_stream_limited(key, expected_encoding, max_bytes)
    }

    fn payload_identity(&self, key: &str) -> Option<BinDataPayloadIdentity> {
        let mut identities = self
            .identities
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(identity) = identities.get(key) {
            return Some(identity.clone());
        }
        let identity = self.inner.payload_identity(key)?;
        identities.insert(key.to_string(), identity.clone());
        Some(identity)
    }
}

/// BinData 바이트의 보관 방식.
///
/// [Task #2263] 파싱 시점에 모든 내장 이미지를 압축 해제해 상주시키면
/// 원본 파일 크기의 수십 배에 달하는 메모리를 쓰게 된다. `Lazy` 는 원본
/// 컨테이너만 보유하고 실제 요청 시점에 해당 항목만 압축을 푼다.
#[derive(Debug, Clone)]
pub enum BinDataBytes {
    /// 메모리에 이미 올라온 바이트 (직렬화기가 새로 추가한 이미지, HML/HWP3 등)
    Loaded(Vec<u8>),
    /// Internally-created immutable payload shared by all render references.
    Shared(std::sync::Arc<[u8]>),
    /// 원본 컨테이너에서 요청 시 압축 해제
    Lazy {
        /// 원본 컨테이너를 보유한 리졸버 (문서 내 모든 항목이 공유)
        resolver: std::sync::Arc<dyn BinDataResolver>,
        /// 리졸버가 해석하는 항목 키 (HWPX: ZIP 엔트리 경로, HWP5: 스토리지 스트림명)
        key: String,
    },
}

/// Bounded payload view used by serializers. In-memory variants stay borrowed;
/// only lazy resolvers return an owned shared payload.
pub(crate) enum BinDataPayload<'a> {
    Borrowed(&'a [u8]),
    Shared(std::sync::Arc<[u8]>),
}

impl AsRef<[u8]> for BinDataPayload<'_> {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Borrowed(bytes) => bytes,
            Self::Shared(bytes) => bytes,
        }
    }
}

impl BinDataBytes {
    pub fn lazy(resolver: std::sync::Arc<dyn BinDataResolver>, key: String) -> Self {
        Self::Lazy { resolver, key }
    }

    /// 바이트를 얻는다. `Lazy` 인 경우 이 시점에 압축을 푼다.
    /// Existing owned-byte API retained for serialization and external callers.
    pub fn load(&self) -> Vec<u8> {
        match self {
            BinDataBytes::Loaded(v) => v.clone(),
            BinDataBytes::Shared(v) => v.as_ref().to_vec(),
            BinDataBytes::Lazy { resolver, key } => resolver.resolve(key),
        }
    }

    /// Get bytes as a shared immutable payload for layout/render paths.
    /// HWPX/HWP5 parser resolvers deduplicate this by source key while any
    /// consumer remains alive.
    pub fn load_shared(&self) -> std::sync::Arc<[u8]> {
        match self {
            BinDataBytes::Loaded(v) => std::sync::Arc::from(v.clone()),
            BinDataBytes::Shared(v) => v.clone(),
            BinDataBytes::Lazy { resolver, key } => resolver.resolve_shared(key),
        }
    }

    /// 최대 `max_bytes` 바이트까지만 로드한다.
    ///
    /// `Loaded` 는 복제 전에 길이를 확인하고, `Lazy` 는 리졸버가 제공하는
    /// bounded read/decompression 경로만 사용한다.
    pub fn load_limited(&self, max_bytes: usize) -> Option<Vec<u8>> {
        match self {
            BinDataBytes::Loaded(v) if v.len() <= max_bytes => Some(v.clone()),
            BinDataBytes::Loaded(_) => None,
            BinDataBytes::Shared(v) if v.len() <= max_bytes => Some(v.as_ref().to_vec()),
            BinDataBytes::Shared(_) => None,
            BinDataBytes::Lazy { resolver, key } => resolver
                .resolve_limited(key, max_bytes)
                .filter(|payload| payload.len() <= max_bytes),
        }
    }

    /// Bounded shared-byte path used by embedded-font and render consumers.
    pub fn load_limited_shared(&self, max_bytes: usize) -> Option<std::sync::Arc<[u8]>> {
        match self {
            BinDataBytes::Loaded(v) if v.len() <= max_bytes => {
                Some(std::sync::Arc::from(v.clone()))
            }
            BinDataBytes::Loaded(_) => None,
            BinDataBytes::Shared(v) if v.len() <= max_bytes => Some(v.clone()),
            BinDataBytes::Shared(_) => None,
            BinDataBytes::Lazy { resolver, key } => resolver
                .resolve_limited_shared(key, max_bytes)
                .filter(|payload| payload.len() <= max_bytes),
        }
    }

    pub(crate) fn load_limited_payload(&self, max_bytes: usize) -> Option<BinDataPayload<'_>> {
        match self {
            BinDataBytes::Loaded(bytes) if bytes.len() <= max_bytes => {
                Some(BinDataPayload::Borrowed(bytes))
            }
            BinDataBytes::Loaded(_) => None,
            BinDataBytes::Shared(bytes) if bytes.len() <= max_bytes => {
                Some(BinDataPayload::Borrowed(bytes))
            }
            BinDataBytes::Shared(_) => None,
            BinDataBytes::Lazy { resolver, key } => resolver
                .resolve_limited_shared(key, max_bytes)
                .filter(|payload| payload.len() <= max_bytes)
                .map(BinDataPayload::Shared),
        }
    }

    /// Exact encoded source stream, available only for lazy data whose source
    /// container is compatible with the destination serializer.
    pub fn load_original_stream_limited(
        &self,
        expected_encoding: BinDataStreamEncoding,
        max_bytes: usize,
    ) -> Option<Vec<u8>> {
        match self {
            BinDataBytes::Lazy { resolver, key } => resolver
                .resolve_original_stream_limited(key, expected_encoding, max_bytes)
                .filter(|stream| stream.len() <= max_bytes),
            BinDataBytes::Loaded(_) | BinDataBytes::Shared(_) => None,
        }
    }

    /// Stable payload identity used by merge and manifest paths. Lazy
    /// resolvers compute this incrementally; this method never falls back to a
    /// full lazy materialization.
    pub(crate) fn payload_identity(&self) -> Option<BinDataPayloadIdentity> {
        match self {
            BinDataBytes::Loaded(bytes) => Some(BinDataPayloadIdentity::decoded(bytes)),
            BinDataBytes::Shared(bytes) => Some(BinDataPayloadIdentity::decoded(bytes)),
            BinDataBytes::Lazy { resolver, key } => resolver.payload_identity(key),
        }
    }

    /// 바이트 길이. `Lazy` 인 경우 압축 해제가 발생하므로 렌더 경로의
    /// 반복 호출은 피하고 `load()` 결과를 재사용한다.
    pub fn len(&self) -> usize {
        match self {
            BinDataBytes::Loaded(v) => v.len(),
            BinDataBytes::Shared(v) => v.len(),
            BinDataBytes::Lazy { .. } => self.load_shared().len(),
        }
    }

    /// 빈 항목인지 판정한다.
    ///
    /// `Lazy` 는 "원본 컨테이너에 엔트리가 있을 것"이라는 기대일 뿐 보장이 아니다.
    /// 매니페스트에는 있으나 실제 엔트리가 없거나(엔트리 누락) 읽기에 실패하는
    /// 경우([#1917] 상한 초과 등) 리졸버가 빈 바이트를 반환하므로, 여기서
    /// 실제로 해석해 봐야 placeholder 의미가 보존된다.
    pub fn is_empty(&self) -> bool {
        match self {
            BinDataBytes::Loaded(v) => v.is_empty(),
            BinDataBytes::Shared(v) => v.is_empty(),
            BinDataBytes::Lazy { .. } => self.load_shared().is_empty(),
        }
    }
}

impl Default for BinDataBytes {
    fn default() -> Self {
        BinDataBytes::Loaded(Vec::new())
    }
}

impl From<Vec<u8>> for BinDataBytes {
    fn from(v: Vec<u8>) -> Self {
        BinDataBytes::Shared(v.into())
    }
}

