const Media = require('@satellite-earth/dev-media');
const Signal = require('@satellite-earth/dev-signal');
const sanitize = require('sanitize-filename');

class Publication extends Signal {

	constructor (payload, signalParams) {

		super(payload, signalParams);

		if (typeof this._signed_.title === 'undefined' || this._signed_.title.length === 0) {
			throw Error('Must specify title in signed data when creating publication');
		}

		if (this.title.length > 160) {
			throw Error('Publication title limited to 160 characters');
		}

		if (this.title !== this.title.trim()) {
			throw Error('Publication title must not contain leading or trailing spaces');
		}

		if (this.title.indexOf('#') !== -1) {
			throw Error('\'#\' is a reserved character in title');
		}

		if (typeof this.subtitle !== 'undefined') {

			if (this.subtitle.length > 200) {
				throw Error('Publication subtitle limited to 200 characters');
			}

			if (this.subtitle !== this.subtitle.trim()) {
				throw Error('Publication subtitle must not contain leading or trailing spaces');
			}
		}

		for (let tag of this.tags) {
			if (tag.length > 32) {
				throw Error('Tags limited to 32 characters');
			}
		}

		// Check that title sanitizes to a non-empty string
		if (typeof this.name === 'undefined') {
			throw Error('Invalid title')
		}
	}

	// Validate and compile elements to create markdown
	async compile (elements, options = {}) {

		if (!Array.isArray(elements)) {
			throw Error('Publication.compile() takes an array of elements');
		}

		if (typeof this.sender === 'undefined') {
			throw Error('Cannot compile publication elements before setting signal params');
		}

		// Bundled media torrents
		const media = [];

		// Add the title
		let markdown = `# ${this.title}\n`;

		// Add the subtitle, if provided
		if (this.subtitle) {
			markdown += `###### ${this.subtitle}\n`;
		}

		const transform = {
			code: (value) => { return value ? `\`\`\`\n${value}\n\`\`\`` : ''; },
			hsmall: (value) => { return value ? `#### ${value}` : ''; },
			hlarge: (value) => { return value ? `### ${value}` : ''; },
			quote: (value) => { return value ? `> ${value}` : ''; },
			text: (value) => { return `${value}`; },
			break: () => { return '* * *'; },
			media: (info) => {

				const model = new Media(info);

				if (!model.dataParams) {
					throw Error('Attempted to add media element without data params');
				}

				if (model.publisher !== this.sender) {
					throw Error('Media publisher must match match publication signer alias');
				}

				// Add media file name, infoHash and byte length to array
				media.push(`${model.mediaName}/${model.infoHash}/${model.length}`);

				// Return markdown embed
				return model.markdown;
			}
		};

		for (let e of elements) { // Iterate over pub elements
			const f = transform[e.type]; // Get transform function

			if (!f) { // Make sure media type is supported
				throw Error(`Unrecognized element type '${e.type}'`);
			}
			
			// Generate markdown segment and append
			//const seg = f(e.type === 'media' ? e : e.value);
			markdown += `\n${f(e.data)}\n`;
		}

		if (media.length > 0) { // Concat media fileNames
			this._signed_.media = media.join('\n');
		}

		// Torrentify the compiled publication
		return await this.data(Buffer.from(markdown, 'utf8'));
	}

	async data (data) {

		// Convert data to markdown string and save
		this.markdown = data.toString('utf8');

		// Heuristically identify and extract elements
		this.elements = [];
		const segments = this.markdown.split(`\`\`\``);
		for (let i = 0; i < segments.length; i++) {
			if (i % 2 === 0) {
				this.elements = this.elements.concat(segments[i].split('\n\n').map((element) => {

					const md = element.trim('\n');
					if (md.substring(0, 5) === '#### ') { // Small header
						return { type: 'hsmall', markdown: md };
					} else if (md.substring(0, 4) === '### ') { // Large header
						return { type: 'hlarge', markdown: md };
					} else if (md.substring(0, 2) === '> ') { // Blockquote
						return { type: 'quote', markdown: md };
					} else if (md === '* * *') { // Break
						return { type: 'break', markdown: md };
					} else if (md.indexOf('_signed_meta') !== -1) { // Media torrent

						let uri;
						let notes = '';
						const i0 = md.indexOf('#');
						const s = md.slice(i0 + 1);
						const i1 = s.indexOf(' ');

						if (i1 === -1) {
							uri = s.slice(0, -1);
						} else {
							uri = s.slice(0, i1);
							notes = s.slice(i1 + 2, -2);
						}

						// Construct the media model
						const model = new Media(uri);
						const data = model.payload;
						if (notes.length > 0) {
							data._params_.notes = notes;
						}

						return { type: 'media', markdown: md, data };

					} else { // Text type
						return { type: 'text', markdown: md };
					}
				}));
			} else {
				this.elements.push({ type: 'code', markdown: segments[i] });
			}
		}

		// Compute torrent params
		return await super.data(data);
	}

	get title () {
		return this._signed_.title.split(' #')[0];
	}

	get subtitle () {
		return this._signed_.subtitle;
	}

	// Get media meta (does not require loading data)
	get manifest () {
		return this._signed_.media ? this._signed_.media.split('\n').map((item, index) => {
			const s = item.split('/');
			return { mediaName: s[0], infoHash: s[1], size: parseInt(s[2]) };
		}) : [];
	}

	// Get models of contained media torrents
	get media () {

		if (typeof this.elements === 'undefined') {
			throw Error('Cannot access media until publication is loaded');
		}

		return this.elements.filter(({ type }) => {
			return type === 'media';
		}).map(({ data }) => {
			return new Media(data);
		});
	}

	// If publication is bio
	get biographical () {
		return this.title === `@${this.sender}`;
	}

	// URI-friendly author and name
	get webId () {

		// Author bios are a special case,
		// identified only by their prefix
		if (this.biographical) {
			return `@${this.sender}`;
		}

		// Make the url clean and human readable
		const s = this.title.replace(/[~!@#%^&*()+={}\[\]:;<>?/.,\|'"’‘”“`´—]/g, '').trim().split(/\s+/).join('-').toLowerCase();

		// Prefix with author name and encode
		return `@${this.sender}:${encodeURIComponent(s)}`;		
	}

	// Get tags parsed from title
	get tags () {

		const s = this._signed_.title.split(' #');
		if (typeof s[1] !== 'undefined') {
			return s[1].split('#');
		}

		return [];
	}

	// True if data has been loaded
	get loaded () {
		return typeof this.elements === 'undefined';
	}

	// Override Torrent class getter to return a
	// filename-safe version of publication title
	// prefixed with the publisher's alias 
	get name () {

		let name = sanitize(this.title.split(' ').join('-').toLowerCase());
		if (name.length === 0) {
			return;
		}

		return `@${this.sender} ${name}.md`;
	}
}

module.exports = Publication;
