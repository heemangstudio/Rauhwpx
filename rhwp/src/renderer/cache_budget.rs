pub(crate) struct WeightedLruBudget {
    max_entries: usize,
    max_weight: usize,
    total_weight: usize,
    weights: std::collections::HashMap<u64, usize>,
    order: std::collections::VecDeque<u64>,
}

impl WeightedLruBudget {
    pub(crate) fn new(max_entries: usize, max_weight: usize) -> Self {
        Self {
            max_entries,
            max_weight,
            total_weight: 0,
            weights: std::collections::HashMap::new(),
            order: std::collections::VecDeque::new(),
        }
    }

    pub(crate) fn touch(&mut self, key: u64) {
        if !self.weights.contains_key(&key) {
            return;
        }
        self.order.retain(|cached| *cached != key);
        self.order.push_back(key);
    }

    pub(crate) fn len(&self) -> usize {
        self.weights.len()
    }

    pub(crate) fn total_weight(&self) -> usize {
        self.total_weight
    }

    pub(crate) fn record(&mut self, key: u64, weight: usize) -> Vec<u64> {
        if let Some(previous) = self.weights.remove(&key) {
            self.total_weight = self.total_weight.saturating_sub(previous);
            self.order.retain(|cached| *cached != key);
        }
        self.weights.insert(key, weight);
        self.total_weight = self.total_weight.saturating_add(weight);
        self.order.push_back(key);

        let mut evicted = Vec::new();
        while self.weights.len() > self.max_entries
            || (self.total_weight > self.max_weight && self.weights.len() > 1)
        {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(removed_weight) = self.weights.remove(&oldest) {
                self.total_weight = self.total_weight.saturating_sub(removed_weight);
                evicted.push(oldest);
            }
        }
        evicted
    }
}

