-- 地址經中華郵政 3+3 郵遞區號服務核對後，記下 6 碼郵遞區號（地址本身存郵局正規化後的寫法）
ALTER TABLE events ADD COLUMN address_zip TEXT;
